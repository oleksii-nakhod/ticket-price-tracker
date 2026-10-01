import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config.js';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbFile = join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);

const defaultData = {
    userCities: {},
    awaitingCity: {},
    eventCache: {},
    siteBlocks: {}, // site -> { level, until }, price requests to a site that blocked us are paused until `until`
    trackedTickets: {}, // chatId -> eventId -> { targetPrice, quantity, lastPrice, lastCheckedAt, alertedPrice }
    trackerHealth: {} // chatId -> { failedCycles, failingSince, lastError, notifiedAt }, only while its checks fail
};
const db = new Low(adapter, defaultData);

// This process is the only writer, so db.data stays current after this initial read.
// Re-reading mid-flight would swap db.data out from under in-progress updates.
await db.read();

// Ensure db.data and its properties are initialized
db.data = db.data || defaultData;
db.data.userCities = db.data.userCities || {};
db.data.awaitingCity = db.data.awaitingCity || {};
db.data.eventCache = db.data.eventCache || {};
db.data.siteBlocks = db.data.siteBlocks || {};
db.data.trackedTickets = db.data.trackedTickets || {};
db.data.trackerHealth = db.data.trackerHealth || {};
// Prices are read from the event page now, so the API cookies aren't needed
delete db.data.tmptCookie;
delete db.data.tmptCookies;

// Tracker health used to be one record shared by all chats, and every chat with tracked tickets was notified
if ('failedCycles' in db.data.trackerHealth) {
    const shared = db.data.trackerHealth;
    db.data.trackerHealth = {};
    if (shared.failedCycles > 0) {
        for (const [chatId, tickets] of Object.entries(db.data.trackedTickets)) {
            if (Object.keys(tickets).length > 0) {
                db.data.trackerHealth[chatId] = { ...shared };
            }
        }
    }
}

// Discovery API error responses (e.g. for a removed event) used to be cached as events
const trackedEventIds = new Set(Object.values(db.data.trackedTickets).flatMap(Object.keys));
for (const [eventId, event] of Object.entries(db.data.eventCache)) {
    if (event.errors && !trackedEventIds.has(eventId)) {
        delete db.data.eventCache[eventId];
    }
}

// Tracked tickets used to store only the target price
for (const tickets of Object.values(db.data.trackedTickets)) {
    for (const [eventId, ticket] of Object.entries(tickets)) {
        if (typeof ticket === 'number') {
            tickets[eventId] = { targetPrice: ticket, quantity: 1 };
        }
    }
}
await db.write();

// A failed Telegram call or browser launch shouldn't take the whole bot down
process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

const token = process.env.TELEGRAM_BOT_TOKEN;
const ticketmasterApiKey = process.env.TICKETMASTER_API_KEY;

// Ticketmaster blocks headless and Playwright-launched browsers, and its event pages no longer use the
// price API we called, so prices are read off the event page in a normally started Chrome window
// (on a server, inside a virtual display) that the bot attaches to. Its profile keeps the cookies
// that show Ticketmaster we're a returning visitor.
const CHROME_PATH = process.env.CHROME_PATH || {
    win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
}[process.platform] || '/opt/google/chrome/chrome';
const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || join(__dirname, 'chrome-profile');
const CHROME_DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT) || 9333;
const PAGE_LOAD_TIMEOUT_MS = 60 * 1000;
let chromeSession = null; // Promise of { chrome, browser, page } while Chrome is running
let chromeProcess = null;

// Hammering Ticketmaster while it blocks us keeps the block going, so a block pauses all price
// requests to that site, for twice as long each time it's still blocked when the pause ends
const BLOCK_PAUSE_MS = 30 * 60 * 1000;
const MAX_BLOCK_PAUSE_MS = 6 * 60 * 60 * 1000;

// Event pages are loaded one at a time in the one tab, with a random gap, like someone clicking through them
const MIN_REQUEST_GAP_MS = 5000;
const MAX_REQUEST_GAP_MS = 15000;
let pageQueue = Promise.resolve();

class TicketmasterBlockedError extends Error {}

// Ticketmaster site an event URL belongs to, or null if it's not one we can price
function ticketmasterSite(eventUrl) {
    const site = new URL(eventUrl).hostname.replace(/^www\./, '');
    return ['ticketmaster.ca', 'ticketmaster.com'].includes(site) ? site : null;
}

// Whether getCheapestTicketPrice can price this event; ones sold elsewhere (TicketWeb, AXS, ...) can't be tracked
function canCheckPrice(event) {
    try {
        return Boolean(event?.url && ticketmasterSite(event.url));
    } catch {
        return false; // malformed URL
    }
}

// Chrome is started once and reused, like a browser left open, and restarted if it closes or crashes
function getTicketmasterPage() {
    chromeSession = chromeSession || startChrome().catch(error => {
        chromeSession = null;
        throw error;
    });
    return chromeSession.then(({ page }) => page);
}

async function startChrome() {
    console.log(`Starting Chrome (${CHROME_PATH}) for Ticketmaster price checks...`);
    const args = [
        `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
        `--user-data-dir=${CHROME_PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1400,1000'
    ];
    if (process.platform === 'linux') {
        // Docker's /dev/shm is too small for Chrome, and its sandbox can't run as root
        args.push('--disable-dev-shm-usage');
        if (process.getuid?.() === 0) args.push('--no-sandbox');
    }
    const chrome = chromeProcess = spawn(CHROME_PATH, [...args, 'about:blank'], { stdio: 'ignore' });
    const exited = new Promise((resolve, reject) => {
        chrome.once('error', reject);
        chrome.once('exit', resolve);
    });
    chrome.once('exit', () => {
        console.log('Chrome closed; it will be restarted for the next price check.');
        chromeSession = null;
    });

    try {
        let browser;
        const deadline = Date.now() + 30 * 1000;
        while (!browser) {
            try {
                browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
            } catch (error) {
                if (Date.now() > deadline) throw new Error(`Couldn't connect to Chrome: ${error.message}`);
                // Chrome failing to start shows up here instead of as a connection timeout
                await Promise.race([exited.then(code => {
                    throw new Error(`Chrome exited during startup (code ${code})`);
                }), new Promise(resolve => setTimeout(resolve, 500))]);
            }
        }
        const context = browser.contexts()[0];
        const page = context.pages()[0] || await context.newPage();
        return { chrome, browser, page };
    } catch (error) {
        chrome.kill();
        throw error;
    }
}

// Otherwise Chrome outlives the bot and holds on to the profile and debugging port
function stopChrome() {
    chromeProcess?.kill();
}
process.on('exit', stopChrome);
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        stopChrome();
        process.exit(0);
    });
}

// Every 3 minutes (~260 requests an hour for 13 events) got this server blocked
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const HEALTH_ALERT_AFTER_FAILED_CYCLES = 2; // ~30 minutes, so a single blip doesn't alert
const HEALTH_REMINDER_MS = 24 * 60 * 60 * 1000;
let isCheckingTickets = false;

// Function to check tracked tickets
async function checkTrackedTickets() {
    // A slow cycle (browser launches, retries) must not overlap the next one
    if (isCheckingTickets) return;
    isCheckingTickets = true;

    // Once a site blocks us, don't keep hammering it for the rest of this cycle
    const blockedSites = new Map(); // site -> TicketmasterBlockedError
    // Chats tracking the same event and quantity share one request
    const priceRequests = new Map(); // `${url}|${quantity}` -> Promise of price data

    try {
        for (const [chatId, tickets] of Object.entries(db.data.trackedTickets)) {
            // Each chat is only told about its own events
            let attempted = 0;
            const failedEvents = [];
            let lastError = null;

            for (const [eventId, ticket] of Object.entries(tickets)) {
                const event = db.data.eventCache[eventId];
                // Not a failure: it could never be checked, and /tracked says so
                if (!canCheckPrice(event)) continue;
                attempted++;

                const blockedError = blockedSites.get(ticketmasterSite(event.url));
                if (blockedError) {
                    failedEvents.push(event);
                    lastError = blockedError;
                    continue;
                }

                console.log(`[Tracker] Checking price for tracked event: ${event.name} (Target: $${ticket.targetPrice}, Qty: ${ticket.quantity})`);

                let priceData;
                try {
                    const key = `${event.url}|${ticket.quantity}`;
                    if (!priceRequests.has(key)) {
                        priceRequests.set(key, getCheapestTicketPrice(event.url, ticket.quantity));
                    }
                    priceData = await priceRequests.get(key);
                } catch (error) {
                    console.error(`[Tracker] Error checking price for event ${eventId}:`, error.message);
                    failedEvents.push(event);
                    lastError = error;
                    if (error instanceof TicketmasterBlockedError) {
                        blockedSites.set(ticketmasterSite(event.url), error);
                    }
                    continue;
                }

                // Untracked, or quantity/target changed, while we were fetching
                if (db.data.trackedTickets[chatId]?.[eventId] !== ticket) continue;

                ticket.lastPrice = priceData;
                ticket.lastCheckedAt = Date.now();

                if (!priceData || priceData.price > ticket.targetPrice) {
                    // Re-arm, so the next dip under the target alerts again
                    ticket.alertedPrice = null;
                } else if (ticket.alertedPrice == null || priceData.price < ticket.alertedPrice) {
                    if (await sendPriceAlert(chatId, event, ticket, priceData)) {
                        ticket.alertedPrice = priceData.price;
                    }
                }
                await db.write();
            }

            if (attempted > 0) {
                console.log(`[Tracker] Completed checking ${attempted} tracked tickets for chat ${chatId} (${failedEvents.length} failed).`);
                await updateTrackerHealth(chatId, attempted, failedEvents, lastError);
            }
        }
    } catch (error) {
        console.error('[Tracker] Unexpected error during check:', error);
    } finally {
        isCheckingTickets = false;
    }
}

async function sendPriceAlert(chatId, event, ticket, priceData) {
    const price = `${priceData.currency} ${priceData.price.toFixed(2)}`;
    const target = `$${ticket.targetPrice.toFixed(2)}`;
    const text = ticket.quantity === 1
        ? html`🎉 <b>${event.name}</b> - Price Alert!\n\nThe cheapest ticket is now <b>${price}</b> (Section: ${priceData.section}), which is below your target of <b>${target}</b>!`
        : html`🎉 <b>${event.name}</b> - Price Alert!\n\nThe cheapest price for ${ticket.quantity} tickets is now <b>${price} each</b> (${priceData.currency} ${(priceData.price * ticket.quantity).toFixed(2)} total, Section: ${priceData.section}), which is below your target of <b>${target}</b> per ticket!`;
    const keyboard = {
        inline_keyboard: [
            [
                { text: '🎟️ Buy Tickets', url: event.url }
            ]
        ]
    };

    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
        return true;
    } catch (error) {
        console.error(`[Tracker] Failed to send price alert to ${chatId}:`, error.message);
        return false;
    }
}

// Plain text on purpose: error messages could break HTML parsing and the notice would be lost
async function notifyChat(chatId, text) {
    try {
        await bot.sendMessage(chatId, text);
        return true;
    } catch (error) {
        console.error(`Failed to notify ${chatId}:`, error.message);
        return false;
    }
}

// Tell a chat when price checks for its events start failing (e.g. Ticketmaster blocks this server) and when they recover
async function updateTrackerHealth(chatId, attempted, failedEvents, lastError) {
    if (failedEvents.length === 0) {
        if (db.data.trackerHealth[chatId]?.notifiedAt) {
            await notifyChat(chatId, '✅ Ticket price checks are working again. Price alerts are back on.');
        }
        if (db.data.trackerHealth[chatId]) {
            delete db.data.trackerHealth[chatId];
            await db.write();
        }
        return;
    }

    const health = db.data.trackerHealth[chatId] = db.data.trackerHealth[chatId] ||
        { failedCycles: 0, failingSince: null, lastError: null, notifiedAt: null };
    health.failedCycles++;
    health.failingSince = health.failingSince || Date.now();
    health.lastError = lastError.message;

    const reminderDue = !health.notifiedAt || Date.now() - health.notifiedAt >= HEALTH_REMINDER_MS;
    if (health.failedCycles >= HEALTH_ALERT_AFTER_FAILED_CYCLES && reminderDue) {
        const scope = failedEvents.length === attempted
            ? `all ${attempted} of your tracked events`
            : `${failedEvents.length} of your ${attempted} tracked events:\n` +
              failedEvents.map(event => `• ${event.name} (${event.dates?.start?.localDate || 'date TBD'})`).join('\n');
        const reason = lastError instanceof TicketmasterBlockedError
            ? `Ticketmaster is blocking requests from this server.\n${lastError.message}`
            : `Last error: ${lastError.message}`;

        const sent = await notifyChat(chatId,
            `⚠️ Ticket price checks are failing for ${scope}\n\nFailing since ${new Date(health.failingSince).toUTCString()}.\n${reason}\n\nYou won't get price alerts for these events until this is fixed.`
        );
        if (sent) {
            health.notifiedAt = Date.now();
        }
    }
    await db.write();
}

setInterval(checkTrackedTickets, CHECK_INTERVAL_MS);

const bot = new TelegramBot(token, { polling: true });

// Throws instead of sending anything while requests to the site are paused after a block
function assertSiteNotPaused(site) {
    const block = db.data.siteBlocks[site];
    if (block && Date.now() < block.until) {
        throw new TicketmasterBlockedError(`Ticketmaster blocked requests to ${site}; price checks are paused until ${new Date(block.until).toUTCString()}`);
    }
}

async function pauseBlockedSite(site) {
    const previous = db.data.siteBlocks[site];
    const level = previous ? previous.level + 1 : 0;
    const pauseMs = Math.min(BLOCK_PAUSE_MS * 2 ** level, MAX_BLOCK_PAUSE_MS);
    db.data.siteBlocks[site] = { level, until: Date.now() + pauseMs };
    await db.write();
    console.warn(`Ticketmaster blocked ${site}. Pausing price checks for ${Math.round(pauseMs / 60000)} minutes.`);
}

// Runs task(page) once the checks queued before it are done, MIN..MAX_REQUEST_GAP_MS after the last one
function withTicketmasterPage(task) {
    const run = pageQueue.then(async () => task(await getTicketmasterPage()));
    const gap = MIN_REQUEST_GAP_MS + Math.random() * (MAX_REQUEST_GAP_MS - MIN_REQUEST_GAP_MS);
    pageQueue = run.catch(() => {}).then(() => new Promise(resolve => setTimeout(resolve, gap)));
    return run;
}

// Cheapest listing that can be bought in the given quantity, as the event page shows it (price is per ticket,
// fees included). Returns null when no such tickets are available; throws when the price couldn't be checked.
async function getCheapestTicketPrice(eventUrl, quantity = 1) {
    const site = ticketmasterSite(eventUrl);
    if (!site) {
        throw new Error(`Price checks aren't supported for ${new URL(eventUrl).hostname}`);
    }
    assertSiteNotPaused(site);

    return withTicketmasterPage(async (page) => {
        // A check ahead in the queue may have been blocked
        assertSiteNotPaused(site);

        await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
        let state = await waitForListings(page, eventUrl);
        if (state === 'blocked') {
            const title = await page.title();
            await pauseBlockedSite(site);
            throw new TicketmasterBlockedError(`Ticketmaster stopped showing event pages on ${site} ("${title}")`);
        }
        if (db.data.siteBlocks[site]) {
            console.log(`Ticketmaster is showing ${site} again.`);
            delete db.data.siteBlocks[site];
            await db.write();
        }
        if (state === 'none') return null;

        // The page ignores a quantity in the URL and starts at the last one picked (2 at first)
        const quantityButton = page.getByRole('button', { name: /current quantity/i }).first();
        const currentQuantity = Number((await quantityButton.textContent()).match(/current quantity: (\d+)/i)?.[1]);
        if (currentQuantity !== quantity) {
            await quantityButton.click();
            const option = page.getByRole('radio', { name: new RegExp(`^Set quantity to: ${quantity} Tickets?$`) });
            if (await option.count() === 0) {
                // Can't be bought in one order, e.g. a limit of 4 tickets per order
                await page.keyboard.press('Escape');
                return null;
            }
            await option.click();
            await page.waitForFunction(
                (quantity) => [...document.querySelectorAll('button')].some(b => b.textContent.includes(`current quantity: ${quantity} `)),
                quantity, { timeout: 10000 });
            // Give the list time to re-render for the new quantity
            await page.waitForTimeout(2000);
            state = await waitForListings(page, eventUrl);
            if (state !== 'listings') return null;
        }

        const listings = await page.$$eval('#list-view li[data-listing-id]', items => items.map(item => ({
            price: [...item.querySelectorAll('*')]
                .find(e => e.children.length === 0 && /^[A-Z]{0,2}\$\s?[\d,]+(\.\d{2})?$/.test(e.textContent.trim()))
                ?.textContent.trim(),
            // "General Admission - Floor", "Sec 112 • Row 4", ...
            section: item.innerText.split('\n')[0].trim()
        })));
        const offers = listings.filter(listing => listing.price).map(listing => ({
            price: Number(listing.price.replace(/[^\d.]/g, '')),
            currency: /^CA/.test(listing.price) ? 'CAD' : /^US/.test(listing.price) ? 'USD' : site === 'ticketmaster.ca' ? 'CAD' : 'USD',
            section: listing.section
        }));
        if (offers.length === 0) {
            throw new Error(`Couldn't read any prices from the event page ${eventUrl}`);
        }
        return offers.reduce((min, offer) => offer.price < min.price ? offer : min);
    });
}

// What the event page settled on: 'listings', 'none' (sold out / no tickets) or 'blocked'. Ticketmaster's
// bot check answers the first load with a 401 and reloads the page once it passes, so this polls.
async function waitForListings(page, eventUrl) {
    try {
        const state = await page.waitForFunction(() => {
            if (/browsing activity has been paused/i.test(document.title)) return 'blocked';
            if (document.querySelector('#list-view li[data-listing-id]')) return 'listings';
            const text = document.body?.innerText || '';
            if (/tickets are sold out|no tickets|no results|\b0 results/i.test(text)) return 'none';
            return false;
        }, null, { timeout: PAGE_LOAD_TIMEOUT_MS, polling: 500 });
        return await state.jsonValue();
    } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        throw new Error(`The event page didn't show any listings within ${PAGE_LOAD_TIMEOUT_MS / 1000}s: ${eventUrl} ("${await page.title()}")`);
    }
}

const QUANTITY_OPTIONS = [1, 2, 3, 4, 5, 6];

// Row of buttons to pick how many tickets to track, current choice checked
function quantityButtons(eventId, selected) {
    return QUANTITY_OPTIONS.map(quantity => ({
        text: quantity === selected ? `✅ ${quantity}` : `${quantity}`,
        callback_data: `qty_${quantity}_${eventId}`
    }));
}

// Template tag for messages sent with parse_mode 'HTML': interpolated values are escaped,
// so event text (names, sections, notes) can't break Telegram's parsing and lose the message
function html(strings, ...values) {
    return strings.reduce((result, string, i) => result + escapeHtml(values[i - 1]) + string);
}

function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Latest price the tracker saw for this ticket's quantity
function formatTrackedPrice(event, ticket) {
    if (!canCheckPrice(event)) return 'Can\'t be checked (only events sold on Ticketmaster can be tracked)';
    if (ticket.lastPrice === undefined) return 'Not checked yet';
    if (ticket.lastPrice === null) return `No tickets available for ${ticket.quantity}`;
    const { price, currency, section } = ticket.lastPrice;
    return `${currency} ${price.toFixed(2)}${ticket.quantity > 1 ? ' each' : ''} (${section})`;
}

function buildManageMessage(eventId, event, ticket) {
    const formatted = formatEvent(event);
    let message = `⚙️ <b>Managing Tracked Ticket:</b>\n\n`;
    message += html`<b>${formatted.name}</b>\n`;
    message += html`📅 <b>Date</b>: ${formatted.date}\n`;
    message += html`🏟 <b>Venue</b>: ${formatted.venue}, ${formatted.city}\n`;
    message += html`🎟 <b>Tickets</b>: ${ticket.quantity}\n`;
    message += html`💵 <b>Current Price</b>: ${formatTrackedPrice(event, ticket)}\n`;
    message += html`🎯 <b>Current Target</b>: $${ticket.targetPrice.toFixed(2)}${ticket.quantity > 1 ? ' each' : ''}\n`;

    const keyboard = {
        inline_keyboard: [
            quantityButtons(eventId, ticket.quantity),
            [
                { text: '✏️ Adjust Price', callback_data: `editprice_${eventId}` },
                { text: '❌ Stop Tracking', callback_data: `untrack_${eventId}` }
            ],
            [
                { text: '🎟️ Buy Tickets', url: formatted.url }
            ]
        ]
    };
    return { message, keyboard };
}

// Shared function to format event data
function formatEvent(event, includeDetails = false) {
    const eventName = event.name || 'Unknown Event';
    const eventDate = formatDate(event.dates?.start?.localDate, event.dates?.start?.localTime);
    const venue = event._embedded?.venues?.[0]?.name || 'Venue TBD';
    const city = event._embedded?.venues?.[0]?.city?.name || 'Unknown City';
    const tags = event.classifications?.[0] ? [
        event.classifications[0].segment?.name,
        event.classifications[0].genre?.name,
        event.classifications[0].subGenre?.name
    ].filter(tag => tag && tag !== 'Undefined').join(', ') : 'No tags available';
    const attractions = event._embedded?.attractions || [];
    const attractionsList = attractions.map(attraction => attraction.name).join(', ') || 'No attractions listed';
    // Face value from the Discovery API: a live price means loading the event page, which takes too long
    // for every search result, so only tracked tickets get one
    const range = event.priceRanges?.[0];
    const priceInfo = !range ? 'See Ticketmaster' :
        range.max > range.min ? `${range.currency} ${range.min.toFixed(2)} - ${range.max.toFixed(2)} (face value)` :
        `${range.currency} ${range.min.toFixed(2)} (face value)`;

    let result = {
        name: eventName,
        date: eventDate,
        venue,
        city,
        tags,
        attractions: attractionsList,
        price: priceInfo,
        url: event.url || 'https://www.ticketmaster.ca',
    };

    if (includeDetails) {
        result.seatmap = event.seatmap?.staticUrl || '';
        result.info = event.info || 'No additional info available';
        result.pleaseNote = event.pleaseNote || 'No special notes';
    }

    return result;
}

// Function to format date
function formatDate(dateStr, timeStr) {
    if (!dateStr) return 'Date TBD';
    const date = new Date(dateStr);
    const options = { month: 'short', day: '2-digit', year: 'numeric' };
    const formattedDate = date.toLocaleDateString('en-US', options);
    const time = timeStr ? timeStr.slice(0, 5) : 'Time TBD';
    return `${formattedDate} at ${time}`;
}

// Set bot commands
bot.setMyCommands([
    { command: '/start', description: 'Start the bot' },
    { command: '/help', description: 'Show help message' },
    { command: '/setcity', description: 'Set your city for event searches' },
    { command: '/tracked', description: 'View all tracked tickets' }
]);

// Handle /start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Welcome to the Ticketmaster Bot! Use /setcity to set your city, then type a keyword to search for events.');
});

// Handle /help command
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `Available commands:
- /start - Start the bot
- /help - Show this help message
- /setcity - Enter city selection mode (then type your city)
- /setcity <city> - Set your city directly
- /tracked - View all tracked tickets
Type any keyword after setting a city to search for events.`);
});

// Handle /tracked command
bot.onText(/\/tracked/, async (msg) => {
    const chatId = msg.chat.id;

    const trackedTickets = db.data.trackedTickets[chatId] || {};
    if (Object.keys(trackedTickets).length === 0) {
        bot.sendMessage(chatId, 'You are not tracking any tickets.');
        return;
    }

    let message = '<b>Your Tracked Tickets:</b>\n\n';
    if (db.data.trackerHealth[chatId]?.failedCycles >= HEALTH_ALERT_AFTER_FAILED_CYCLES) {
        message += '⚠️ Price checks are currently failing, so prices below may be out of date.\n\n';
    }
    let index = 1;
    const keyboard = { inline_keyboard: [] };
    let row = [];

    for (const [eventId, ticket] of Object.entries(trackedTickets)) {
        const event = db.data.eventCache[eventId];
        if (!event) continue;

        const formatted = formatEvent(event);
        message += html`${index}. <b>${formatted.name}</b>\n`;
        message += html`   📅 <b>Date</b>: ${formatted.date}\n`;
        message += html`   🎟 <b>Tickets</b>: ${ticket.quantity}\n`;
        message += html`   💵 <b>Current Price</b>: ${formatTrackedPrice(event, ticket)}\n`;
        message += html`   🎯 <b>Target Price</b>: $${ticket.targetPrice.toFixed(2)}${ticket.quantity > 1 ? ' each' : ''}\n\n`;
        
        row.push({ text: `Manage ${index}`, callback_data: `manage_${eventId}` });
        if (row.length === 3) {
            keyboard.inline_keyboard.push(row);
            row = [];
        }
        index++;
    }

    if (row.length > 0) {
        keyboard.inline_keyboard.push(row);
    }

    bot.sendMessage(chatId, message, { parse_mode: 'HTML', reply_markup: keyboard });
});

// Handle /setcity with city name
bot.onText(/\/setcity (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const city = match[1].trim();

    db.data.userCities[chatId] = city;
    db.data.awaitingCity[chatId] = false;
    await db.write();

    bot.sendMessage(chatId, `City set to ${city}. Now search for events by typing a keyword.`);
});

// Handle /setcity without arguments
bot.onText(/\/setcity$/, async (msg) => {
    const chatId = msg.chat.id;
    db.data.awaitingCity[chatId] = true;
    await db.write();
    bot.sendMessage(chatId, 'Please type the city name:', {
        reply_markup: { force_reply: true }
    });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    if (text.startsWith('/')) {
        let stateChanged = false;

        if (db.data.awaitingCity && db.data.awaitingCity[chatId] && !text.startsWith('/setcity')) {
            db.data.awaitingCity[chatId] = false;
            stateChanged = true;
        }
        
        if (db.data.awaitingPrice && db.data.awaitingPrice[chatId]) {
            delete db.data.awaitingPrice[chatId];
            stateChanged = true;
        }

        if (stateChanged) {
            await db.write();
        }
        return;
    }

    db.data.awaitingCity = db.data.awaitingCity || {};
    db.data.eventCache = db.data.eventCache || {};
    db.data.trackedTickets = db.data.trackedTickets || {};

    // Check if user is in city-setting mode
    if (db.data.awaitingCity[chatId]) {
        const city = text.trim();
        db.data.userCities[chatId] = city;
        db.data.awaitingCity[chatId] = false;
        await db.write();
        bot.sendMessage(chatId, `City set to ${city}. Now search for events by typing a keyword.`);
        return;
    }

    // Check if user is in price-setting mode for tracking
    if (db.data.awaitingPrice && db.data.awaitingPrice[chatId]) {
        const price = parseFloat(text);
        if (isNaN(price) || price <= 0) {
            bot.sendMessage(chatId, 'Please enter a valid price number.');
            return;
        }

        const { eventId, isUpdate } = db.data.awaitingPrice[chatId];
        const event = db.data.eventCache[eventId];
        if (!event) {
            bot.sendMessage(chatId, 'Error: Event data not found. Please try again.');
            delete db.data.awaitingPrice[chatId];
            await db.write();
            return;
        }

        db.data.trackedTickets[chatId] = db.data.trackedTickets[chatId] || {};
        const quantity = db.data.trackedTickets[chatId][eventId]?.quantity || 1;
        // New object resets the last price/alert state, which were for the old target
        db.data.trackedTickets[chatId][eventId] = { targetPrice: price, quantity };
        delete db.data.awaitingPrice[chatId];
        await db.write();

        const actionText = isUpdate ? 'Target price updated for' : 'Now tracking';
        bot.sendMessage(chatId, html`${actionText} <b>${event.name}</b>. You'll be notified when the price drops to ${price.toFixed(2)} or below per ticket.\n\nHow many tickets do you need?`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [quantityButtons(eventId, quantity)] }
        });
        return;
    }

    const city = db.data.userCities[chatId];

    if (!city) {
        bot.sendMessage(chatId, 'Please set a city first using /setcity');
        return;
    }

    const keyword = encodeURIComponent(text);
    const encodedCity = encodeURIComponent(city);

    try {
        let geoPointParam = '';
        try {
            const geoResponse = await fetch(
                `https://geocoding-api.open-meteo.com/v1/search?name=${encodedCity}&count=1&language=en&format=json`
            ).then(res => res.json());
            if (geoResponse.results && geoResponse.results.length > 0) {
                const loc = geoResponse.results[0];
                geoPointParam = `&geoPoint=${loc.latitude},${loc.longitude}&radius=30&unit=miles`;
                console.log(`Geocoded "${city}" to latitude: ${loc.latitude}, longitude: ${loc.longitude}. Searching within 30 miles.`);
            }
        } catch (geoError) {
            console.error('Geocoding error:', geoError.message);
        }

        const url = geoPointParam
            ? `https://app.ticketmaster.com/discovery/v2/events?apikey=${ticketmasterApiKey}&keyword=${keyword}${geoPointParam}`
            : `https://app.ticketmaster.com/discovery/v2/events?apikey=${ticketmasterApiKey}&city=${encodedCity}&keyword=${keyword}`;

        const response = await fetch(url).then(response => response.json());

        const events = response._embedded?.events || [];

        if (events.length === 0) {
            bot.sendMessage(chatId, `No events found for "${text}" in ${city}.`);
            return;
        }

        let message = '🎉 <b>Events found:</b>\n\n';
        const keyboard = { inline_keyboard: [] };
        
        // Filter out cancelled events and limit to 10
        const validEvents = events
            .filter(event => event.dates?.status?.code.toLowerCase() !== 'cancelled')
            .slice(0, 10);

        if (validEvents.length === 0) {
            bot.sendMessage(chatId, `No valid upcoming events found for "${text}" in ${city}.`);
            return;
        }

        for (const event of validEvents) {
            db.data.eventCache[event.id] = event;
        }
        await db.write();

        validEvents.forEach((event, index) => {
            const formatted = formatEvent(event);
            message += html`${index + 1}. <b>${formatted.name}</b>\n\n    🎤 <b>Performing</b>: ${formatted.attractions}\n    📅 <b>Date</b>: ${formatted.date}\n    🏟 <b>Venue</b>: ${formatted.venue}, ${formatted.city}\n    💵 <b>Price</b>: ${formatted.price}\n    🏷 <b>Tags</b>: ${formatted.tags}\n\n`;
            keyboard.inline_keyboard.push([{ text: `${index + 1}. ${formatted.name} - ${formatted.date} - ${formatted.price}`, callback_data: `view_${event.id}` }]);
        });

        // Add first image from the first event, if available
        const firstEventImage = validEvents[0]?.images?.[0]?.url;
        if (firstEventImage && message.length <= 950) {
            await bot.sendPhoto(chatId, firstEventImage, {
                caption: message,
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        } else {
            if (firstEventImage) {
                try {
                    await bot.sendPhoto(chatId, firstEventImage);
                } catch (photoError) {
                    console.error('Error sending photo:', photoError.message);
                }
            }
            await bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        }

    } catch (error) {
        console.error('Error fetching events:', error.message);
        bot.sendMessage(chatId, 'Sorry, there was an error searching for events. Please try again later.');
    }
});

// Modified callback query handler
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('view_')) {
        const eventId = data.substring(data.indexOf('_') + 1);

        try {
            let event = db.data.eventCache[eventId];

            if (!event) {
                // Fallback to API if not in cache
                const res = await fetch(
                    `https://app.ticketmaster.com/discovery/v2/events/${eventId}?apikey=${ticketmasterApiKey}`
                );
                // Don't cache the error response as if it were the event
                if (res.status === 404) {
                    bot.sendMessage(chatId, 'Sorry, this event is no longer available on Ticketmaster.');
                    bot.answerCallbackQuery(query.id);
                    return;
                }
                if (!res.ok) {
                    throw new Error(`Discovery API returned status ${res.status} for event ${eventId}`);
                }
                const response = await res.json();

                // Cache the event
                db.data.eventCache[eventId] = response;
                await db.write();

                event = response;
            }

            const formatted = formatEvent(event, true);

            let infoText = formatted.info || 'No additional info available';
            if (infoText.length > 250) {
                infoText = infoText.substring(0, 250) + '...';
            }
            let pleaseNoteText = formatted.pleaseNote || 'No special notes';
            if (pleaseNoteText.length > 150) {
                pleaseNoteText = pleaseNoteText.substring(0, 150) + '...';
            }

            let caption = html`<b>${formatted.name}</b>\n\n`;
            caption += html`🎤 <b>Performing</b>: ${formatted.attractions}\n`;
            caption += html`📅 <b>Date</b>: ${formatted.date}\n`;
            caption += html`🏟 <b>Venue</b>: ${formatted.venue}, ${formatted.city}\n`;
            caption += html`💵 <b>Price</b>: ${formatted.price}\n`;
            caption += html`🏷 <b>Tags</b>: ${formatted.tags}\n`;
            caption += html`\n📝 <b>Info</b>: ${infoText}\n`;
            caption += html`⚠ <b>Please Note</b>: ${pleaseNoteText}`;

            const keyboard = {
                inline_keyboard: [
                    [
                        // Events sold elsewhere (TicketWeb, AXS, ...) can't be price checked
                        ...(canCheckPrice(event) ? [{ text: 'Track Price', callback_data: `track_${eventId}` }] : []),
                        { text: 'Buy Tickets', url: formatted.url }
                    ]
                ]
            };

            // Photo captions are capped at 1024 characters, and cutting HTML could split a tag,
            // so a description too long for a caption goes in its own message after the seat map
            const MAX_CAPTION_LENGTH = 950;
            if (formatted.seatmap && caption.length <= MAX_CAPTION_LENGTH) {
                await bot.sendPhoto(chatId, formatted.seatmap, {
                    caption,
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
            } else {
                if (formatted.seatmap) {
                    try {
                        await bot.sendPhoto(chatId, formatted.seatmap);
                    } catch (photoError) {
                        console.error('Error sending seat map:', photoError.message);
                    }
                }
                await bot.sendMessage(chatId, caption, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
            }

            bot.answerCallbackQuery(query.id);
        } catch (error) {
            console.error('Error fetching event details:', error.message);
            bot.sendMessage(chatId, 'Sorry, there was an error fetching event details. Please try again later.');
            bot.answerCallbackQuery(query.id);
        }
    } else if (data.startsWith('track_')) {
        const eventId = data.substring(data.indexOf('_') + 1);
        // Messages sent before the Track button was hidden for these events still have it
        if (!canCheckPrice(db.data.eventCache[eventId])) {
            bot.answerCallbackQuery(query.id, {
                text: 'Price tracking only works for events sold on Ticketmaster.',
                show_alert: true
            });
            return;
        }
        db.data.awaitingPrice = db.data.awaitingPrice || {};
        db.data.awaitingPrice[chatId] = { eventId };
        await db.write();

        bot.sendMessage(chatId, 'Please enter your target price per ticket for tracking this event:', {
            reply_markup: { force_reply: true }
        });
        bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('manage_')) {
        const eventId = data.substring(data.indexOf('_') + 1);
        const event = db.data.eventCache[eventId];
        const ticket = db.data.trackedTickets[chatId]?.[eventId];

        if (!event || ticket === undefined) {
            bot.sendMessage(chatId, 'This ticket is no longer being tracked or the event data is missing.');
            bot.answerCallbackQuery(query.id);
            return;
        }

        const { message, keyboard } = buildManageMessage(eventId, event, ticket);
        bot.sendMessage(chatId, message, { parse_mode: 'HTML', reply_markup: keyboard });
        bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('qty_')) {
        const [, quantityText, eventId] = data.match(/^qty_(\d+)_(.+)$/);
        const quantity = Number(quantityText);
        const ticket = db.data.trackedTickets[chatId]?.[eventId];

        if (!ticket) {
            bot.answerCallbackQuery(query.id, { text: 'This ticket is no longer being tracked' });
            return;
        }

        if (ticket.quantity !== quantity) {
            // New object resets the last price/alert state, which were for the old quantity
            const updated = { targetPrice: ticket.targetPrice, quantity };
            db.data.trackedTickets[chatId][eventId] = updated;
            await db.write();

            const messageOptions = { chat_id: chatId, message_id: query.message.message_id };
            const isManageMessage = query.message.reply_markup?.inline_keyboard
                .some(row => row.some(button => button.callback_data?.startsWith('editprice_')));
            try {
                if (isManageMessage && db.data.eventCache[eventId]) {
                    const { message, keyboard } = buildManageMessage(eventId, db.data.eventCache[eventId], updated);
                    await bot.editMessageText(message, { ...messageOptions, parse_mode: 'HTML', reply_markup: keyboard });
                } else {
                    await bot.editMessageReplyMarkup({ inline_keyboard: [quantityButtons(eventId, quantity)] }, messageOptions);
                }
            } catch (error) {
                console.error('Error updating quantity buttons:', error.message);
            }
        }

        bot.answerCallbackQuery(query.id, { text: `Tracking ${quantity} ticket${quantity > 1 ? 's' : ''}` });
    } else if (data.startsWith('editprice_')) {
        const eventId = data.substring(data.indexOf('_') + 1);
        db.data.awaitingPrice = db.data.awaitingPrice || {};
        db.data.awaitingPrice[chatId] = { eventId, isUpdate: true };
        await db.write();

        bot.sendMessage(chatId, 'Please enter your <b>new</b> target price per ticket for tracking this event:', {
            parse_mode: 'HTML',
            reply_markup: { force_reply: true }
        });
        bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('untrack_')) {
        const eventId = data.substring(data.indexOf('_') + 1);

        if (db.data.trackedTickets[chatId] && db.data.trackedTickets[chatId][eventId] !== undefined) {
            delete db.data.trackedTickets[chatId][eventId];
            // Nothing left to check, so no failure or recovery notices either
            if (Object.keys(db.data.trackedTickets[chatId]).length === 0) {
                delete db.data.trackerHealth[chatId];
            }
            await db.write();

            const event = db.data.eventCache[eventId];
            const eventName = event?.name || 'Unknown Event';

            try {
                 await bot.editMessageText(html`❌ Stopped tracking <b>${eventName}</b>.`, {
                     chat_id: chatId,
                     message_id: query.message.message_id,
                     parse_mode: 'HTML'
                 });
            } catch (err) {
                 bot.sendMessage(chatId, html`❌ Stopped tracking <b>${eventName}</b>.`, { parse_mode: 'HTML' });
            }
        }
        
        bot.answerCallbackQuery(query.id, { text: 'Ticket tracking stopped' });
    }
});

bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

// Initial price check on startup (cookies are fetched per site as needed)
(async () => {
    try {
        await checkTrackedTickets();
        console.log('Bot is running...');
    } catch (error) {
        console.error('Error during startup initialization:', error);
    }
})();