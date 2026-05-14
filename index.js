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
    tmptCookie: { value: null, timestamp: 0 },
    trackedTickets: {} // Stores only event IDs
};
const db = new Low(adapter, defaultData);

await db.read();

// Ensure db.data and its properties are initialized
db.data = db.data || defaultData;
db.data.userCities = db.data.userCities || {};
db.data.awaitingCity = db.data.awaitingCity || {};
db.data.eventCache = db.data.eventCache || {};
db.data.tmptCookie = db.data.tmptCookie || { value: null, timestamp: 0 };
db.data.trackedTickets = db.data.trackedTickets || {};
await db.write();

const token = process.env.TELEGRAM_BOT_TOKEN;
const ticketmasterApiKey = process.env.TICKETMASTER_API_KEY;

// Function to fetch tmpt cookie
async function fetchTmptCookie() {
    // Check if cookie exists and is not expired
    const COOKIE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
    const currentTime = Date.now();

    if (db.data.tmptCookie.value &&
        (currentTime - db.data.tmptCookie.timestamp < COOKIE_EXPIRY_MS)) {
        console.log('Using existing valid tmpt cookie');
        return db.data.tmptCookie.value;
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        locale: 'en-US',
        viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    try {
        const eventUrl = 'https://www.ticketmaster.ca/event/1000628FBC992E22';
        await page.goto(eventUrl, { waitUntil: 'domcontentloaded' });

        let tmptCookie = null;
        const maxWaitTime = 30000;
        const checkInterval = 500;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            const cookies = await context.cookies();
            tmptCookie = cookies.find(cookie => cookie.name === 'tmpt');
            if (tmptCookie) {
                console.log('tmpt cookie found:', tmptCookie);
                break;
            }
            await page.waitForTimeout(checkInterval);
        }

        if (!tmptCookie) {
            console.error('tmpt cookie was not found within the timeout period');
            return null;
        }

        const cookieValue = `${tmptCookie.name}=${tmptCookie.value}`;
        db.data.tmptCookie = {
            value: cookieValue,
            timestamp: Date.now()
        };
        await db.write();
        return cookieValue;

    } catch (error) {
        console.error('Error fetching tmpt cookie:', error.message);
        return null;
    } finally {
        await browser.close();
    }
}

// Function to get valid tmpt cookie
async function getValidTmptCookie() {
    return await fetchTmptCookie();
}

// Schedule periodic cookie refresh
setInterval(async () => {
    console.log('Checking tmpt cookie...');
    await fetchTmptCookie();
}, 60 * 60 * 1000); // Every hour

// Function to check tracked tickets
async function checkTrackedTickets() {
    await db.read();

    for (const [chatId, ticketIds] of Object.entries(db.data.trackedTickets)) {
        for (const [eventId, targetPrice] of Object.entries(ticketIds)) {
            try {
                const event = db.data.eventCache[eventId];
                if (!event) continue;

                const eventDiscoveryId = event.url.split('/').pop();
                const priceData = await getCheapestTicketPrice(eventDiscoveryId);

                if (priceData && priceData.price <= targetPrice && priceData.price < (event.cheapestPrice?.price || Infinity)) {
                    // Send notification to user
                    await bot.sendMessage(chatId,
                        `🎉 Price alert! The cheapest ticket for *${event.name}* is now *${priceData.currency} ${priceData.price.toFixed(2)}* (Section: ${priceData.section}), which is below your target of *${targetPrice.toFixed(2)}*!`,
                        { parse_mode: 'Markdown' }
                    );
                }

                // Update cached price
                if (priceData) {
                    db.data.eventCache[eventId].cheapestPrice = priceData;
                    await db.write();
                }
            } catch (error) {
                console.error(`Error checking price for event ${eventId}:`, error.message);
            }
        }
    }
}

// Schedule price checks every 5 minutes
setInterval(checkTrackedTickets, 5 * 60 * 1000);

const bot = new TelegramBot(token, { polling: true });

// Modified function to fetch cheapest ticket price
async function getCheapestTicketPrice(eventId) {
    try {
        const tmptCookie = await getValidTmptCookie();
        if (!tmptCookie) {
            console.error('No valid tmpt cookie available');
            return null;
        }

        const response = await fetch(
            `https://offeradapter.ticketmaster.ca/api/ismds/event/${eventId}/quickpicks?` + new URLSearchParams({
                show: 'places+maxQuantity+sections',
                mode: 'primary:ppsectionrow+resale:ga_areas+platinum:all',
                qty: 1,
                q: 'not(\'accessible\')',
                embed: 'offer',
                apikey: process.env.TICKETMASTER_PUBLIC_API_KEY,
                apisecret: process.env.TICKETMASTER_PUBLIC_API_SECRET,
                limit: 40,
                offset: 0,
                sort: 'noTaxTotalprice'
            }),
            {
                headers: {
                    'Referer': 'https://www.ticketmaster.ca/',
                    'TMPS-Correlation-Id': uuidv4(),
                    'Cookie': tmptCookie
                }
            }
        ).then(res => res.json());
        const offers = response._embedded?.offer || [];

        if (offers.length === 0) return null;

        const validOffers = offers.filter(offer => offer.sellableQuantities.includes(1));

        if (validOffers.length === 0) return null;

        const cheapestOffer = validOffers.reduce((min, offer) =>
            (!min || offer.totalPrice < min.totalPrice) ? offer : min, null);

        return cheapestOffer ? {
            price: cheapestOffer.totalPrice,
            currency: cheapestOffer.currency,
            section: cheapestOffer.section
        } : null;
    } catch (error) {
        console.error(`Error fetching ticket price for event ${eventId}:`, error.message);
        return null;
    }
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
    await db.read();

    const trackedTickets = db.data.trackedTickets[chatId] || {};
    if (Object.keys(trackedTickets).length === 0) {
        bot.sendMessage(chatId, 'You are not tracking any tickets.');
        return;
    }

    let message = '*Your Tracked Tickets:*\n\n';
    let index = 1;
    const keyboard = { inline_keyboard: [] };
    let row = [];

    for (const [eventId, targetPrice] of Object.entries(trackedTickets)) {
        const event = db.data.eventCache[eventId];
        if (!event) continue;

        const formatted = formatEvent(event);
        message += `${index}. *${formatted.name}*\n`;
        message += `   📅 *Date*: ${formatted.date}\n`;
        message += `   💵 *Current Price*: ${formatted.price}\n`;
        message += `   🎯 *Target Price*: $${targetPrice.toFixed(2)}\n\n`;
        
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
        await db.read();
        
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

    await db.read();
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
        db.data.trackedTickets[chatId][eventId] = price;
        delete db.data.awaitingPrice[chatId];
        await db.write();

        const actionText = isUpdate ? 'Target price updated for' : 'Now tracking';
        bot.sendMessage(chatId, `${actionText} *${event.name}*. You'll be notified when the price drops to ${price.toFixed(2)} or below.`, { parse_mode: 'Markdown' });
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
        const response = await fetch(
            `https://app.ticketmaster.com/discovery/v2/events?apikey=${ticketmasterApiKey}&city=${encodedCity}&keyword=${keyword}`
        ).then(response => response.json());

        const events = response._embedded?.events || [];

        if (events.length === 0) {
            bot.sendMessage(chatId, `No events found for "${text}" in ${city}.`);
            return;
        }

        let message = '🎉 *Events found:*\n\n';
        const keyboard = { inline_keyboard: [] };
        
        // Filter out cancelled events and limit to 5 to avoid caption too long error
        const validEvents = events
            .filter(event => event.dates?.status?.code.toLowerCase() !== 'cancelled')
            .slice(0, 5);

        if (validEvents.length === 0) {
            bot.sendMessage(chatId, `No valid upcoming events found for "${text}" in ${city}.`);
            return;
        }

        // Fetch cheapest ticket prices in parallel
        const pricePromises = validEvents.map(async (event) => {
            let priceData = null;
            if (event.url) {
                const eventDiscoveryId = event.url.split('/').pop();
                priceData = await getCheapestTicketPrice(eventDiscoveryId);
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
        if (firstEventImage) {
            await bot.sendPhoto(chatId, firstEventImage, {
                caption: message,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } else {
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
            await db.read();
            let event = db.data.eventCache[eventId];

            if (!event) {
                // Fallback to API if not in cache
                const response = await fetch(
                    `https://app.ticketmaster.com/discovery/v2/events/${eventId}?apikey=${ticketmasterApiKey}`
                ).then(response => response.json());

                let priceData = null;
                if (response.url) {
                    const eventDiscoveryId = response.url.split('/').pop();
                    priceData = await getCheapestTicketPrice(eventDiscoveryId);
                }
                response.cheapestPrice = priceData;

                // Cache the event
                db.data.eventCache[eventId] = response;
                await db.write();

                event = response;
            }

            const formatted = formatEvent(event, true);

            let caption = `*${formatted.name}*\n\n`;
            caption += `🎤 *Performing*: ${formatted.attractions}\n`;
            caption += `📅 *Date*: ${formatted.date}\n`;
            caption += `🏟 *Venue*: ${formatted.venue}, ${formatted.city}\n`;
            caption += `💵 *Cheapest Ticket*: ${formatted.price}\n`;
            caption += `🏷 *Tags*: ${formatted.tags}\n`;
            caption += `\n📝 *Info*: ${formatted.info}\n`;
            caption += `⚠ *Please Note*: ${formatted.pleaseNote}`;

            const MAX_CAPTION_LENGTH = 800; // Leave a little buffer for formatting tags
            if (caption.length > MAX_CAPTION_LENGTH) {
                caption = caption.substring(0, MAX_CAPTION_LENGTH) + '... (truncated)';
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

        bot.sendMessage(chatId, 'Please enter your target price for tracking this event:', {
            reply_markup: { force_reply: true }
        });
        bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('manage_')) {
        const eventId = data.substring(data.indexOf('_') + 1);
        await db.read();
        const event = db.data.eventCache[eventId];
        const targetPrice = db.data.trackedTickets[chatId]?.[eventId];
        
        if (!event || targetPrice === undefined) {
            bot.sendMessage(chatId, 'This ticket is no longer being tracked or the event data is missing.');
            bot.answerCallbackQuery(query.id);
            return;
        }

        const formatted = formatEvent(event);
        let message = `⚙️ *Managing Tracked Ticket:*\n\n`;
        message += `*${formatted.name}*\n`;
        message += `📅 *Date*: ${formatted.date}\n`;
        message += `🏟 *Venue*: ${formatted.venue}, ${formatted.city}\n`;
        message += `💵 *Current Price*: ${formatted.price}\n`;
        message += `🎯 *Current Target*: $${targetPrice.toFixed(2)}\n`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '✏️ Adjust Price', callback_data: `editprice_${eventId}` },
                    { text: '❌ Stop Tracking', callback_data: `untrack_${eventId}` }
                ],
                [
                    { text: '🎟️ Buy Tickets', url: formatted.url }
                ]
            ]
        };

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: keyboard });
        bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('editprice_')) {
        const eventId = data.substring(data.indexOf('_') + 1);
        db.data.awaitingPrice = db.data.awaitingPrice || {};
        db.data.awaitingPrice[chatId] = { eventId, isUpdate: true };
        await db.write();

        bot.sendMessage(chatId, 'Please enter your *new* target price for tracking this event:', { 
            parse_mode: 'Markdown',
            reply_markup: { force_reply: true }
        });
        bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('untrack_')) {
        const eventId = data.substring(data.indexOf('_') + 1);
        await db.read();
        
        if (db.data.trackedTickets[chatId] && db.data.trackedTickets[chatId][eventId] !== undefined) {
            delete db.data.trackedTickets[chatId][eventId];
            await db.write();
            
            const event = db.data.eventCache[eventId];
            const eventName = event ? event.name : 'Unknown Event';
            
            try {
                 bot.editMessageText(`❌ Stopped tracking *${eventName}*.`, {
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

// Initial cookie fetch and price check on startup
Promise.all([
    fetchTmptCookie(),
    checkTrackedTickets()
]).then(() => {
    console.log('Bot is running...');
});