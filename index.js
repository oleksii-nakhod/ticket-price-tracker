import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config.js';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbFile = join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);

const defaultData = {
    userCities: {},
    awaitingCity: {},
    eventCache: {},
    tmptCookies: {}, // site ('ticketmaster.ca' / 'ticketmaster.com') -> { value, timestamp }
    trackedTickets: {}, // chatId -> eventId -> { targetPrice, quantity, lastPrice, lastCheckedAt, alertedPrice }
    trackerHealth: { failedCycles: 0, failingSince: null, lastError: null, notifiedAt: null }
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
db.data.tmptCookies = db.data.tmptCookies || {};
db.data.trackedTickets = db.data.trackedTickets || {};
db.data.trackerHealth = db.data.trackerHealth || { ...defaultData.trackerHealth };
delete db.data.tmptCookie; // replaced by per-site tmptCookies

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

const COOKIE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
// While Ticketmaster blocks us every request fails, and launching a browser for each one
// exhausted the container (EAGAIN / launch timeouts), so refetch at most this often per site
const COOKIE_REFETCH_COOLDOWN_MS = 10 * 60 * 1000;
const lastCookieFetchAt = {};
const pendingCookieFetches = {};

class TicketmasterBlockedError extends Error {}

// Ticketmaster site an event URL belongs to, or null if it's not one we can price
function ticketmasterSite(eventUrl) {
    const site = new URL(eventUrl).hostname.replace(/^www\./, '');
    return ['ticketmaster.ca', 'ticketmaster.com'].includes(site) ? site : null;
}

// Function to fetch tmpt cookie by loading an event page of the given site
async function fetchTmptCookie(eventUrl, site) {
    console.log(`Fetching fresh tmpt cookie for ${site} using Playwright...`);
    let browser;

    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            locale: 'en-US',
            viewport: { width: 1280, height: 720 },
        });
        const page = await context.newPage();
        await page.goto(eventUrl, { waitUntil: 'domcontentloaded' });

        let tmptCookie = null;
        const maxWaitTime = 30000;
        const checkInterval = 500;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            const cookies = await context.cookies();
            tmptCookie = cookies.find(cookie => cookie.name === 'tmpt');
            if (tmptCookie) {
                console.log('tmpt cookie found:', tmptCookie.value ? 'Yes' : 'No');
                break;
            }
            await page.waitForTimeout(checkInterval);
        }

        if (!tmptCookie) {
            console.error('tmpt cookie was not found within the timeout period');
            return null;
        }

        const cookieValue = `${tmptCookie.name}=${tmptCookie.value}`;
        db.data.tmptCookies[site] = {
            value: cookieValue,
            timestamp: Date.now()
        };
        await db.write();
        return cookieValue;

    } catch (error) {
        console.error('Error fetching tmpt cookie:', error.message);
        return null;
    } finally {
        await browser?.close().catch(() => {});
    }
}

// Function to get valid tmpt cookie for the event's site
async function getValidTmptCookie(eventUrl, force = false) {
    const site = ticketmasterSite(eventUrl);
    const cached = db.data.tmptCookies[site];

    if (!force && cached?.value && (Date.now() - cached.timestamp < COOKIE_EXPIRY_MS)) {
        return cached.value;
    }
    // Concurrent lookups (e.g. a search's parallel price fetches) share one browser launch
    if (pendingCookieFetches[site]) {
        return pendingCookieFetches[site];
    }
    if (Date.now() - (lastCookieFetchAt[site] || 0) < COOKIE_REFETCH_COOLDOWN_MS) {
        return cached?.value || null;
    }

    lastCookieFetchAt[site] = Date.now();
    pendingCookieFetches[site] = fetchTmptCookie(eventUrl, site)
        .finally(() => delete pendingCookieFetches[site]);
    return pendingCookieFetches[site];
}

const HEALTH_ALERT_AFTER_FAILED_CYCLES = 2; // ~6 minutes, so a single blip doesn't alert
const HEALTH_REMINDER_MS = 24 * 60 * 60 * 1000;
let isCheckingTickets = false;

// Function to check tracked tickets
async function checkTrackedTickets() {
    // A slow cycle (browser launches, retries) must not overlap the next one
    if (isCheckingTickets) return;
    isCheckingTickets = true;

    let attempted = 0;
    const failedEvents = [];
    let lastError = null;
    const blockedSites = new Set();

    try {
        for (const [chatId, tickets] of Object.entries(db.data.trackedTickets)) {
            for (const [eventId, ticket] of Object.entries(tickets)) {
                const event = db.data.eventCache[eventId];
                if (!event?.url) continue;
                attempted++;

                // Once a site blocks us, don't keep hammering it for the rest of this cycle
                if (blockedSites.has(ticketmasterSite(event.url))) {
                    failedEvents.push(event);
                    continue;
                }

                console.log(`[Tracker] Checking price for tracked event: ${event.name} (Target: $${ticket.targetPrice}, Qty: ${ticket.quantity})`);

                let priceData;
                try {
                    priceData = await getCheapestTicketPrice(event.url, ticket.quantity);
                } catch (error) {
                    console.error(`[Tracker] Error checking price for event ${eventId}:`, error.message);
                    failedEvents.push(event);
                    lastError = error;
                    if (error instanceof TicketmasterBlockedError) {
                        blockedSites.add(ticketmasterSite(event.url));
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
        }

        if (attempted > 0) {
            console.log(`[Tracker] Completed checking ${attempted} tracked tickets (${failedEvents.length} failed).`);
            await updateTrackerHealth(attempted, failedEvents, lastError);
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
        ? `🎉 *${event.name}* - Price Alert!\n\nThe cheapest ticket is now *${price}* (Section: ${priceData.section}), which is below your target of *${target}*!`
        : `🎉 *${event.name}* - Price Alert!\n\nThe cheapest price for ${ticket.quantity} tickets is now *${price} each* (${priceData.currency} ${(priceData.price * ticket.quantity).toFixed(2)} total, Section: ${priceData.section}), which is below your target of *${target}* per ticket!`;
    const keyboard = {
        inline_keyboard: [
            [
                { text: '🎟️ Buy Tickets', url: event.url }
            ]
        ]
    };

    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
        return true;
    } catch (error) {
        console.error(`[Tracker] Failed to send price alert to ${chatId}:`, error.message);
        return false;
    }
}

// Plain text on purpose: error messages could break Markdown parsing and the notice would be lost
async function notifyChats(chatIds, text) {
    let sent = 0;
    for (const chatId of chatIds) {
        try {
            await bot.sendMessage(chatId, text);
            sent++;
        } catch (error) {
            console.error(`Failed to notify ${chatId}:`, error.message);
        }
    }
    return sent;
}

// Tell users when price checks start failing (e.g. Ticketmaster blocks this server) and when they recover
async function updateTrackerHealth(attempted, failedEvents, lastError) {
    const health = db.data.trackerHealth;
    const chatIds = Object.keys(db.data.trackedTickets)
        .filter(chatId => Object.keys(db.data.trackedTickets[chatId]).length > 0);

    if (failedEvents.length === 0) {
        if (health.notifiedAt) {
            await notifyChats(chatIds, '✅ Ticket price checks are working again. Price alerts are back on.');
        }
        if (health.failedCycles > 0) {
            db.data.trackerHealth = { ...defaultData.trackerHealth };
            await db.write();
        }
        return;
    }

    health.failedCycles++;
    health.failingSince = health.failingSince || Date.now();
    health.lastError = lastError.message;

    const reminderDue = !health.notifiedAt || Date.now() - health.notifiedAt >= HEALTH_REMINDER_MS;
    if (health.failedCycles >= HEALTH_ALERT_AFTER_FAILED_CYCLES && reminderDue) {
        const scope = failedEvents.length === attempted
            ? `all ${attempted} tracked events`
            : `${failedEvents.length} of ${attempted} tracked events:\n` +
              failedEvents.map(event => `• ${event.name} (${event.dates?.start?.localDate || 'date TBD'})`).join('\n');
        const reason = lastError instanceof TicketmasterBlockedError
            ? `Ticketmaster is blocking requests from this server.\n${lastError.message}`
            : `Last error: ${lastError.message}`;

        const sent = await notifyChats(chatIds,
            `⚠️ Ticket price checks are failing for ${scope}\n\nFailing since ${new Date(health.failingSince).toUTCString()}.\n${reason}\n\nYou won't get price alerts for these events until this is fixed.`
        );
        if (sent > 0) {
            health.notifiedAt = Date.now();
        }
    }
    await db.write();
}

// Schedule price checks every 3 minutes
setInterval(checkTrackedTickets, 3 * 60 * 1000);

const bot = new TelegramBot(token, { polling: true });

// Fetch the cheapest offer that can be bought in the given quantity (price is per ticket).
// Returns null when no such tickets are available; throws when the price couldn't be checked.
async function getCheapestTicketPrice(eventUrl, quantity = 1, retryCount = 0) {
    const site = ticketmasterSite(eventUrl);
    if (!site) {
        throw new Error(`Price checks aren't supported for ${new URL(eventUrl).hostname}`);
    }
    const eventId = eventUrl.split('?')[0].split('/').pop();

    try {
        // A retry means the previous response was rejected, so ask for a fresh cookie
        const tmptCookie = await getValidTmptCookie(eventUrl, retryCount > 0);
        if (!tmptCookie) {
            throw new Error(`No valid tmpt cookie available for ${site}`);
        }

        // US events are only served by the .com API; the .ca one returns no offers for them
        const url = `https://offeradapter.${site}/api/ismds/event/${eventId}/quickpicks?` + new URLSearchParams({
            show: 'places+maxQuantity+sections',
            mode: 'primary:ppsectionrow+resale:ga_areas+platinum:all',
            qty: quantity,
            q: 'not(\'accessible\')',
            embed: 'offer',
            apikey: process.env.TICKETMASTER_PUBLIC_API_KEY,
            apisecret: process.env.TICKETMASTER_PUBLIC_API_SECRET,
            limit: 40,
            offset: 0,
            sort: 'noTaxTotalprice'
        });

        const res = await fetch(url, {
            headers: {
                'Referer': `https://www.${site}/`,
                'TMPS-Correlation-Id': uuidv4(),
                'Cookie': tmptCookie
            }
        });

        if (res.status === 401 || res.status === 403) {
            if (retryCount < 1) {
                console.log(`Received status ${res.status} for event ${eventId}. Refreshing cookie and retrying...`);
                return await getCheapestTicketPrice(eventUrl, quantity, retryCount + 1);
            }
            const body = await res.text();
            throw new TicketmasterBlockedError(`Received status ${res.status} for event ${eventId} on retry: ${body.slice(0, 100)}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json') && !contentType.includes('application/hal+json')) {
            const text = await res.text();
            if (text.trim().startsWith('<') || res.status !== 200) {
                if (retryCount < 1) {
                    console.log(`Received HTML/non-JSON response (status ${res.status}) for event ${eventId}. Refreshing cookie and retrying...`);
                    return await getCheapestTicketPrice(eventUrl, quantity, retryCount + 1);
                }
                throw new Error(`Received HTML/non-JSON response (status ${res.status}) for event ${eventId} on retry`);
            }
        }

        if (!res.ok) {
            throw new Error(`Received status ${res.status} for event ${eventId}`);
        }

        const response = await res.json();
        const offers = response._embedded?.offer || [];

        // Offers that can't be split down to exactly this quantity (e.g. a pair sold together) are excluded
        const validOffers = offers.filter(offer => offer.sellableQuantities?.includes(quantity));

        if (validOffers.length === 0) return null;

        const cheapestOffer = validOffers.reduce((min, offer) =>
            (!min || offer.totalPrice < min.totalPrice) ? offer : min, null);

        return {
            price: cheapestOffer.totalPrice,
            currency: cheapestOffer.currency,
            section: cheapestOffer.section
        };
    } catch (error) {
        if (retryCount < 1 && (error.message.includes('Unexpected token') || error.message.includes('JSON'))) {
            console.log(`JSON parsing failed for event ${eventId}. Refreshing cookie and retrying...`);
            return await getCheapestTicketPrice(eventUrl, quantity, retryCount + 1);
        }
        throw error;
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

// Latest price the tracker saw for this ticket's quantity
function formatTrackedPrice(ticket) {
    if (ticket.lastPrice === undefined) return 'Not checked yet';
    if (ticket.lastPrice === null) return `No tickets available for ${ticket.quantity}`;
    const { price, currency, section } = ticket.lastPrice;
    return `${currency} ${price.toFixed(2)}${ticket.quantity > 1 ? ' each' : ''} (${section})`;
}

function buildManageMessage(eventId, event, ticket) {
    const formatted = formatEvent(event);
    let message = `⚙️ *Managing Tracked Ticket:*\n\n`;
    message += `*${formatted.name}*\n`;
    message += `📅 *Date*: ${formatted.date}\n`;
    message += `🏟 *Venue*: ${formatted.venue}, ${formatted.city}\n`;
    message += `🎟 *Tickets*: ${ticket.quantity}\n`;
    message += `💵 *Current Price*: ${formatTrackedPrice(ticket)}\n`;
    message += `🎯 *Current Target*: $${ticket.targetPrice.toFixed(2)}${ticket.quantity > 1 ? ' each' : ''}\n`;

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
    const priceInfo = event.cheapestPrice ?
        `${event.cheapestPrice.currency} ${event.cheapestPrice.price.toFixed(2)} (${event.cheapestPrice.section})` :
        'Price not available';

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

    let message = '*Your Tracked Tickets:*\n\n';
    if (db.data.trackerHealth.failedCycles >= HEALTH_ALERT_AFTER_FAILED_CYCLES) {
        message += '⚠️ Price checks are currently failing, so prices below may be out of date.\n\n';
    }
    let index = 1;
    const keyboard = { inline_keyboard: [] };
    let row = [];

    for (const [eventId, ticket] of Object.entries(trackedTickets)) {
        const event = db.data.eventCache[eventId];
        if (!event) continue;

        const formatted = formatEvent(event);
        message += `${index}. *${formatted.name}*\n`;
        message += `   📅 *Date*: ${formatted.date}\n`;
        message += `   🎟 *Tickets*: ${ticket.quantity}\n`;
        message += `   💵 *Current Price*: ${formatTrackedPrice(ticket)}\n`;
        message += `   🎯 *Target Price*: $${ticket.targetPrice.toFixed(2)}${ticket.quantity > 1 ? ' each' : ''}\n\n`;
        
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

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: keyboard });
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
        bot.sendMessage(chatId, `${actionText} *${event.name}*. You'll be notified when the price drops to ${price.toFixed(2)} or below per ticket.\n\nHow many tickets do you need?`, {
            parse_mode: 'Markdown',
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

        let message = '🎉 *Events found:*\n\n';
        const keyboard = { inline_keyboard: [] };
        
        // Filter out cancelled events and limit to 10
        const validEvents = events
            .filter(event => event.dates?.status?.code.toLowerCase() !== 'cancelled')
            .slice(0, 10);

        if (validEvents.length === 0) {
            bot.sendMessage(chatId, `No valid upcoming events found for "${text}" in ${city}.`);
            return;
        }

        // Fetch cheapest ticket prices in parallel
        const pricePromises = validEvents.map(async (event) => {
            let priceData = null;
            if (event.url) {
                priceData = await getCheapestTicketPrice(event.url).catch(error => {
                    console.error(`Error fetching ticket price for event ${event.id}:`, error.message);
                    return null;
                });
            }
            event.cheapestPrice = priceData;

            // Cache event data
            db.data.eventCache[event.id] = {
                ...event,
                cheapestPrice: priceData
            };
            return event;
        });

        await Promise.all(pricePromises);
        await db.write();

        validEvents.forEach((event, index) => {
            const formatted = formatEvent(event);
            message += `${index + 1}. *${formatted.name}*\n\n    🎤 *Performing*: ${formatted.attractions}\n    📅 *Date*: ${formatted.date}\n    🏟 *Venue*: ${formatted.venue}, ${formatted.city}\n    💵 *Cheapest Ticket*: ${formatted.price}\n    🏷 *Tags*: ${formatted.tags}\n\n`;
            keyboard.inline_keyboard.push([{ text: `${index + 1}. ${formatted.name} - ${formatted.date} - ${formatted.price}`, callback_data: `view_${event.id}` }]);
        });

        // Add first image from the first event, if available
        const firstEventImage = validEvents[0]?.images?.[0]?.url;
        if (firstEventImage && message.length <= 950) {
            await bot.sendPhoto(chatId, firstEventImage, {
                caption: message,
                parse_mode: 'Markdown',
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
                parse_mode: 'Markdown',
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
                const response = await fetch(
                    `https://app.ticketmaster.com/discovery/v2/events/${eventId}?apikey=${ticketmasterApiKey}`
                ).then(response => response.json());

                let priceData = null;
                if (response.url) {
                    priceData = await getCheapestTicketPrice(response.url).catch(error => {
                        console.error(`Error fetching ticket price for event ${eventId}:`, error.message);
                        return null;
                    });
                }
                response.cheapestPrice = priceData;

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

            let caption = `*${formatted.name}*\n\n`;
            caption += `🎤 *Performing*: ${formatted.attractions}\n`;
            caption += `📅 *Date*: ${formatted.date}\n`;
            caption += `🏟 *Venue*: ${formatted.venue}, ${formatted.city}\n`;
            caption += `💵 *Cheapest Ticket*: ${formatted.price}\n`;
            caption += `🏷 *Tags*: ${formatted.tags}\n`;
            caption += `\n📝 *Info*: ${infoText}\n`;
            caption += `⚠ *Please Note*: ${pleaseNoteText}`;

            const MAX_CAPTION_LENGTH = 950;
            if (caption.length > MAX_CAPTION_LENGTH) {
                caption = caption.substring(0, MAX_CAPTION_LENGTH);
                const asteriskCount = (caption.match(/\*/g) || []).length;
                if (asteriskCount % 2 !== 0) {
                    caption += '*';
                }
                caption += '... (truncated)';
            }

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: 'Track Price', callback_data: `track_${eventId}` },
                        { text: 'Buy Tickets', url: formatted.url }
                    ]
                ]
            };

            if (formatted.seatmap) {
                await bot.sendPhoto(chatId, formatted.seatmap, {
                    caption,
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            } else {
                await bot.sendMessage(chatId, caption, {
                    parse_mode: 'Markdown',
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
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: keyboard });
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
                    await bot.editMessageText(message, { ...messageOptions, parse_mode: 'Markdown', reply_markup: keyboard });
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

        bot.sendMessage(chatId, 'Please enter your *new* target price per ticket for tracking this event:', {
            parse_mode: 'Markdown',
            reply_markup: { force_reply: true }
        });
        bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('untrack_')) {
        const eventId = data.substring(data.indexOf('_') + 1);

        if (db.data.trackedTickets[chatId] && db.data.trackedTickets[chatId][eventId] !== undefined) {
            delete db.data.trackedTickets[chatId][eventId];
            await db.write();

            const event = db.data.eventCache[eventId];
            const eventName = event ? event.name : 'Unknown Event';

            try {
                 await bot.editMessageText(`❌ Stopped tracking *${eventName}*.`, {
                     chat_id: chatId,
                     message_id: query.message.message_id,
                     parse_mode: 'Markdown'
                 });
            } catch (err) {
                 bot.sendMessage(chatId, `❌ Stopped tracking *${eventName}*.`, { parse_mode: 'Markdown' });
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