// test- ignore me
import { App, LogLevel, type BlockAction } from '@slack/bolt';
import { WebClient, type GenericMessageEvent, type KnownBlock, type Logger } from "@slack/web-api";
import { answerQuestion, parseQAs } from "./ai";
import { generateEmbedding } from "./embedding";
import { db } from "./db";
import { questionsTable, citationsTable } from "./schema";
import { extractPlaintextFromMessage } from "./utils";
import type { MessageElement } from "@slack/web-api/dist/types/response/ConversationsRepliesResponse";
import * as dotenv from 'dotenv';
import * as fs from 'fs-extra';
import * as path from 'path';
import type { Block } from 'typescript';

dotenv.config();
const faqData = fs.readFileSync("lib/faq.md").toString()
const detailsData = fs.readFileSync("lib/details.md").toString() // Added details.md
// Define channel IDs from env vars
const HELP_CHANNEL = process.env.HELP_CHANNEL!;
const TICKETS_CHANNEL = process.env.TICKETS_CHANNEL!;
const DATA_FILE_PATH = path.join(__dirname, 'ticket-data.json');
const AI_ENDPOINT = process.env.AI_ENDPOINT || 'error: AI_ENDPOINT not set';

// In-memory mapping of ticket message IDs to original message info
interface TicketInfo {
    originalChannel: string;
    originalTs: string;
    ticketMessageTs: string;
    claimers: string[];
    notSure: string[];
    AIQuickResponse: string;
}

interface ReactionEvent {
    reaction: string;
    item: {
        channel: string;
        ts: string;
    };
    user: string;
}
interface LBEntry {
    slack_id: string;
    count_of_tickets: number;
}
const tickets: Record<string, TicketInfo> = {};
// Additional map to quickly look up tickets by original message timestamp
const ticketsByOriginalTs: Record<string, string> = {};

// evan this concerns me, why are we saving data in json :heavysob:
let lbForToday: LBEntry[] = []
// Function to save ticket data to a file
async function saveTicketData() {
    try {
        const data = {
            tickets,
            ticketsByOriginalTs,
            lbForToday
        };
        await fs.writeJSON(DATA_FILE_PATH, data, { spaces: 2 });
        console.log('Ticket data saved to file');
    } catch (error) {
        console.error('Error saving ticket data to file:', error);
    }
}

// Function to load ticket data from a file
async function loadTicketData() {
    try {
        if (await fs.pathExists(DATA_FILE_PATH)) {
            const data = await fs.readJSON(DATA_FILE_PATH);

            // Clear existing data first
            Object.keys(tickets).forEach(key => delete tickets[key]);
            Object.keys(ticketsByOriginalTs).forEach(key => delete ticketsByOriginalTs[key]);
            lbForToday = []
            // Load data from file
            if (data.tickets) {
                Object.assign(tickets, data.tickets);
            }
            if (data.ticketsByOriginalTs) {
                Object.assign(ticketsByOriginalTs, data.ticketsByOriginalTs);
            }
            if (data.lbForToday) {
                lbForToday = data.lbForToday
            }

            console.log(`Loaded ${Object.keys(tickets).length} tickets from file`);
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error loading ticket data from file:', error);
        return false;
    }
}

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.WARN,
});

// Cache of ticket channel members (user IDs)
let ticketChannelMembers: string[] = [];

// Utility: format a Slack timestamp for a URL (remove the decimal point)
function formatTs(ts: string): string {
    return ts.replace('.', '');
}

function createTicketBlocks(AIQuickResponse: string, originalMessageChannelID: string, originalMessageTs: string, claimText?: string, showAIResponse: boolean = false): any[] {
    const headerText = claimText ? claimText : 'Not Claimed';

    // Start with the header section
    const blocks = [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: "*" + headerText + "*",
                // emoji: true
            }
        }
    ];

    if (showAIResponse) {
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: `*Quick response:* ${AIQuickResponse}`
            }
        });
    }

    // Add action buttons
    blocks.push({
        type: "actions",
        //@ts-ignore
        elements: [
            {
                type: "button",
                style: "primary",
                text: {
                    type: "plain_text",
                    text: "Mark Resolved",
                    emoji: true
                },
                value: "claim_button",
                action_id: "mark_resolved"
            },
            {
                type: "button",
                style: "danger",
                text: {
                    type: "plain_text",
                    text: "Seen, Not Sure",
                    emoji: true
                },
                value: "not_sure_button",
                action_id: "not_sure"
            },
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: showAIResponse ? "Hide AI Response" : "Show AI Response",
                    emoji: true
                },
                value: showAIResponse ? "hide_ai_response" : "show_ai_response",
                action_id: showAIResponse ? "hide_ai_response" : "show_ai_response"
            },
            {
                type: "users_select",
                placeholder: {
                    type: "plain_text",
                    text: "Assign (will DM assignee)",
                    emoji: true
                },
                action_id: "assign_user"
            }
        ]
    });

    // Add thread link
    blocks.push({
        type: "section",
        text: {
            type: "mrkdwn",
            text: `<https://${process.env.SLACK_WORKSPACE_DOMAIN || 'yourworkspace.slack.com'}.slack.com/archives/${originalMessageChannelID}/p${formatTs(originalMessageTs)}|View Thread>`
        }
    });

    return blocks;
}

// Function to refresh the list of ticket channel members
async function refreshTicketChannelMembers(client: WebClient) {
    try {
        const result = await client.conversations.members({
            channel: TICKETS_CHANNEL
        });

        if (result.ok && result.members) {
            ticketChannelMembers = result.members;
            return true;
        }
        return false;
    } catch (error) {
        console.error("Failed to fetch ticket channel members:", error);
        return false;
    }
}

// Check if a user is a member of the tickets channel
function isTicketChannelMember(userId: string): boolean {
    return ticketChannelMembers.includes(userId);
}

// Function to get a ticket by its original thread timestamp
function getTicketByOriginalTs(originalTs: string): TicketInfo | null {
    const ticketTs = ticketsByOriginalTs[originalTs];
    if (!ticketTs) return null;
    return tickets[ticketTs] ?? null;
}

// Function to get a ticket by its ticket timestamp
function getTicketByTicketTs(ticketTs: string): TicketInfo | null {
    return tickets[ticketTs] || null;
}

// Function to create a ticket
async function createTicket(message: { text: string; ts: string; channel: string; user: string }, client: WebClient, logger: Logger) {
    try {
        let aiResponse;
        try {
            aiResponse = JSON.parse(await fetchAIResponse(
                `Use the following data to help you!:\n ${faqData}\n` +
                `Shipwrecked Event Details:\n ${detailsData}\n` +
                "Please return ONLY A JSON with a potential response. " +
                "The JSON should have the accessor of .response. " +
                "Please make the potential response really friendly while not being cheesy. " +
                "Please have a normal reply tone, for example, if the user asks what is 1+2, you would reply 1+2 is 3. Another example, If the user asks how to get from boston logan to the aquarium, you would reply Take the silver line to the blue line" +
                "DO NOT REPOND IN A CODE BLOCK, JUST A PURE JSON. Here is the question:" + message.text
            ));
        } catch (parseError) {
            console.error("Failed to parse AI response:", parseError);
            aiResponse = { response: "I couldn't generate a response. Please try again or contact a staff member directly." };
        }

        // Post the ticket message to the tickets channel
        const result = await client.chat.postMessage({
            text: "Open to view message",
            channel: TICKETS_CHANNEL,
            blocks: createTicketBlocks(aiResponse.response, message.channel, message.ts)
        });

        if (result.ok && result.ts) {
            // Save mapping of ticket message to original message info
            const ticketInfo: TicketInfo = {
                originalChannel: message.channel,
                originalTs: message.ts,
                ticketMessageTs: result.ts,
                claimers: [],
                notSure: [],
                AIQuickResponse: aiResponse.response
            };

            tickets[result.ts] = ticketInfo;
            ticketsByOriginalTs[message.ts] = result.ts;

            console.info(`Ticket created for message ${message.ts} as ${result.ts}`);

            // Save ticket data after creating a new ticket
            await saveTicketData();

            return ticketInfo;
        }
    } catch (error) {
        logger.error("Error creating ticket:", error);
    }
    return null;
}

// Function to update a ticket message with new information
async function updateTicketMessage(ticket: TicketInfo, client: WebClient, logger: Logger, showAIResponse: boolean = false) {
    if (!ticket) return false;

    try {
        // Create claim text based on who has claimed it
        let headerText = 'Not Claimed';

        if (ticket.claimers.length > 0) {
            headerText = `Claimed by: ${ticket.claimers.map(id => `<@${id}>`).join(', ')}`;
        } else if (ticket.notSure.length > 0) {
            headerText = `Not Claimed | Not sure: ${ticket.notSure.map(id => `<@${id}>`).join(', ')}`;
        }

        // Update the ticket message with the current information
        await client.chat.update({
            channel: TICKETS_CHANNEL,
            ts: ticket.ticketMessageTs,
            text: "Open to view message",
            blocks: createTicketBlocks(
                ticket.AIQuickResponse,
                ticket.originalChannel,
                ticket.originalTs,
                headerText,
                showAIResponse
            )
        });

        // Save ticket data after updating a ticket
        await saveTicketData();

        return true;
    } catch (error) {
        logger.error("Error updating ticket message:", error);
        return false;
    }
}

// Function to claim a ticket
async function claimTicket(userId: string, ticketTs: string, client: WebClient, logger: Logger) {
    const ticket = getTicketByTicketTs(ticketTs);
    if (!ticket) return false;

    // Add the user to claimers if not already there
    if (!ticket.claimers.includes(userId)) {
        ticket.claimers.push(userId);
    }

    return await updateTicketMessage(ticket, client, logger);
}

// Function to mark a ticket as "not sure"
async function markTicketAsNotSure(userId: string, ticketTs: string, client: WebClient, logger: Logger) {
    const ticket = getTicketByTicketTs(ticketTs);
    if (!ticket) return false;

    if (!ticket.notSure.includes(userId)) {
        ticket.notSure.push(userId);
    }

    return await updateTicketMessage(ticket, client, logger);
}

// Function to resolve (delete) a ticket
async function resolveTicket(ticketTs: string, resolver: string, client: WebClient, logger: Logger, ai: boolean = false) {
    try {
        const ticket = getTicketByTicketTs(ticketTs);
        if (!ticket) return false;
        // Check if the original message still exists before resolving
        try {
            const originalMessageCheck = await client.conversations.history({
                channel: ticket.originalChannel,
                latest: ticket.originalTs,
                inclusive: true,
                limit: 1
            });

            // If the message doesn't exist or we couldn't find it, log and continue with resolution
            if (!originalMessageCheck.ok || !originalMessageCheck.messages || originalMessageCheck.messages.length === 0) {
                logger.warn(`Original message for ticket ${ticketTs} no longer exists or is inaccessible. Proceeding with ticket resolution.`);
            } else {
                // Reply to the original thread to notify the user
                await client.chat.postMessage({
                    channel: ticket.originalChannel,
                    thread_ts: ticket.originalTs,
                    text: `:white_check_mark: This ticket has been marked as resolved. Please send a new message in <#${HELP_CHANNEL}> to create a new ticket if you have another question. ${ai ? "" : "You're welcome to continue asking follow-up questions in this thread!"}`
                });
            }
        } catch (error) {
            logger.warn(`Failed to check original message for ticket ${ticketTs}:`, error);
            // Continue with resolution even if we can't verify the original message
        }

        // Delete the ticket message from the tickets channel
        await client.chat.delete({
            channel: TICKETS_CHANNEL,
            ts: ticketTs
        });

        // Clean up our records
        delete ticketsByOriginalTs[ticket.originalTs];
        delete tickets[ticketTs];
        const newEntry = Array.from(lbForToday)
        const existing = newEntry.find(e => e.slack_id === resolver);
        if (existing) {
            existing.count_of_tickets += 1;
        } else {
            newEntry.push({
                slack_id: resolver,
                count_of_tickets: 1
            });
        }
        lbForToday = newEntry; // Assign the updated array back
        // Save ticket data after resolving a ticket
        await saveTicketData();

        return true;
    } catch (error) {
        logger.error("Error resolving ticket:", error);
        return false;
    }
}

// Listen for messages in the help channel to create tickets
app.event('message', async ({ event, client, logger }) => {
    if (event.channel !== HELP_CHANNEL) return;

    // but allow images uploads 
    if (event.subtype && event.subtype !== 'file_share') return;

    if (event.thread_ts) return;

    const message = event as { text: string; ts: string; channel: string; user: string };

    // non-empty text
    if (!message.text && event.subtype === 'file_share') {
        message.text = "[Image/File uploaded]";
    }

    await createTicket(message, client, logger);
    // send welcome message
    await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `:wave-pikachu-2: Thank you for creating a ticket! Someone will help you soon. Make sure to read the <https://hackclub.slack.com/docs/T0266FRGM/F08NW544FMM|Faq> to see if it answers your question!`
    })

    const text = extractPlaintextFromMessage({
        blocks: event.blocks ?? [],
    } as any);
    if (!text || text.length === 0) return;

    const answer = await answerQuestion(text);
    console.log(answer);
    if (!answer.hasAnswer) return;

    const messageBlocks = [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `Here are some previous answers to similar questions I found: ${answer.sources
                    ?.map((s, i) => `<${s}|#${i + 1}>`)
                    .join(" ")}`,
            },
        },
    ];

    await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: answer.answer,
        unfurl_links: true,
        unfurl_media: true,
        blocks: messageBlocks,
    });
    await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: answer.answer,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "Does that answer your question?",
                },
            },
            {
                type: "actions",
                elements: [
                    {
                        type: "button",
                        style: "primary",
                        text: {
                            type: "plain_text",
                            text: "Yes",
                            emoji: true
                        },
                        value: "answer_helped_button",
                        action_id: "ai_mark_resolved"
                    },
                    // {
                    //     type: "button",
                    //     style: "danger",
                    //     text: {
                    //         type: "plain_text",
                    //         text: "No",
                    //         emoji: true
                    //     },
                    //     value: "answer_didnt_help_button",
                    //     action_id: "respond_didnt_help"
                    // }
                ]
            }
        ],
    });
});

// Listen for thread replies in the help channel to handle claims
app.event('message', async ({ event, client, logger }) => {
    // Only process thread replies in the help channel
    if (event.subtype) return; // Skip edited messages, etc.
    if (!(event.thread_ts) || event.channel !== HELP_CHANNEL || event.thread_ts === event.ts) return;


    const threadReply = event as { thread_ts: string; user: string };

    // Skip if user is not a member of the tickets channel
    if (!isTicketChannelMember(threadReply.user)) {
        logger.info(`User ${threadReply.user} tried to claim a ticket but is not in the tickets channel`);
        return;
    }

    // Get the ticket by the original thread timestamp
    const ticket = getTicketByOriginalTs(threadReply.thread_ts);

    if (ticket) {
        // Use the claimTicket function to claim the ticket
        const success = await claimTicket(threadReply.user, ticket.ticketMessageTs, client, logger);
        if (success) {
            logger.info(`Ticket ${ticket.ticketMessageTs} claimed by ${threadReply.user}`);
        }
    }
});

// Handle button action "Mark Resolved"
app.action('mark_resolved', async ({ body, ack, client, logger }) => {
    await ack();

    if (body.type!=='block_actions') {
        logger.warn('Unexpected body type for mark_resolved action');
        return;
    }

    const userId = (body.user || {}).id;
    // Skip if user is not a member of the tickets channel
    if (!isTicketChannelMember(userId)) {
        logger.info(`User ${userId} tried to resolve a ticket but is not in the tickets channel`);
        return;
    }

    const ticketTs = body.message?.ts;
    if (!ticketTs) return;

    const success = await resolveTicket(ticketTs, userId, client, logger);
    if (success) {
        logger.info(`Ticket ${ticketTs} marked as resolved (deleted) by ${userId}`);
    }
});

// Handle button action "Seen, Not Sure"
app.action('not_sure', async ({ body, ack, client, logger }) => {
    await ack();

    if (body.type!=='block_actions') {
        logger.warn('Unexpected body type for mark_resolved action');
        return;
    }

    const ticketTs = body.message?.ts;
    const userId = (body.user || {}).id;

    if (!ticketTs || !userId) return;

    // Skip if user is not a member of the tickets channel
    if (!isTicketChannelMember(userId)) {
        logger.info(`User ${userId} tried to mark "not sure" but is not in the tickets channel`);
        return;
    }

    const success = await markTicketAsNotSure(userId, ticketTs, client, logger);
    if (success) {
        logger.info(`Ticket ${ticketTs} marked as "not sure" by ${userId}`);
    }
});

// Handle assign user action
app.action('assign_user', async ({ body, ack, client, logger }) => {
    await ack();

    if (body.type!=='block_actions') {
        logger.warn('Unexpected body type for mark_resolved action');
        return;
    }
    

    const userId = (body.user || {}).id;
    // Skip if user is not a member of the tickets channel
    if (!isTicketChannelMember(userId)) {
        logger.info(`User ${userId} tried to assign a ticket but is not in the tickets channel`);
        return;
    }

    const ticketTs = body .message?.ts;

    const action = body.actions?.[0];
    if (!action || action.type !== 'users_select') {
        logger.warn('Action is not a users_select action');
        return;
    }

    const selectedUser = action.selected_user;

    if (!ticketTs || !selectedUser) return;

    const ticket = getTicketByTicketTs(ticketTs);
    if (!ticket) return;


    try {
        // DM the assigned user
        await client.chat.postMessage({
            channel: selectedUser,
            text: `You have been assigned a ticket from <#${TICKETS_CHANNEL}>. Please check it out & claim it by replying.\n<https://${process.env.SLACK_WORKSPACE_DOMAIN || 'yourworkspace.slack.com'}.slack.com/archives/${TICKETS_CHANNEL}/p${formatTs(ticket.ticketMessageTs)}|View Ticket>`
        });

        logger.info(`User ${selectedUser} was assigned ticket ${ticketTs}`);
    } catch (error) {
        logger.error(error);
    }
});

app.action('show_ai_response', async ({ body, ack, client, logger }) => {
    await ack();

    if (body.type!=='block_actions') {
        logger.warn('Unexpected body type for mark_resolved action');
        return;
    }

    const userId = (body.user || {}).id;
    if (!isTicketChannelMember(userId)) {
        logger.info(`User ${userId} tried to show AI response but is not in the tickets channel`);
        return;
    }

    const ticketTs = body.message?.ts;
    if (!ticketTs) return;

    const ticket = getTicketByTicketTs(ticketTs);
    if (!ticket) return;

    const success = await updateTicketMessage(ticket, client, logger, true);
    if (success) {
        logger.info(`AI response for ticket ${ticketTs} shown by ${userId}`);
    }
});

app.action('hide_ai_response', async ({ body, ack, client, logger }) => {
    await ack();

    if (body.type!=='block_actions') {
        logger.warn('Unexpected body type for mark_resolved action');
        return;
    }

    const userId = (body.user || {}).id;
    if (!isTicketChannelMember(userId)) {
        logger.info(`User ${userId} tried to hide AI response but is not in the tickets channel`);
        return;
    }

    const ticketTs = body.message?.ts;
    if (!ticketTs) return;

    const ticket = getTicketByTicketTs(ticketTs);
    if (!ticket) return;

    const success = await updateTicketMessage(ticket, client, logger, false);
    if (success) {
        logger.info(`AI response for ticket ${ticketTs} hidden by ${userId}`);
    }
});

app.action('ai_mark_resolved', async ({ body, ack, client, logger }) => {
    await ack();

    if (body.type!=='block_actions') {
        logger.warn('Unexpected body type for mark_resolved action');
        return;
    }

    const userId = (body.user || {}).id;
    const channelId = body.channel?.id;
    const messageTs = body.message?.thread_ts || body.message?.ts;

    if (!channelId || !messageTs) {
        logger.warn('Missing channelId or messageTs in ai_mark_resolved action');
        return;
    }

    try {
        try {
            await client.reactions.add({
                channel: channelId,
                timestamp: messageTs,
                name: "white_check_mark"
            });
        }
        catch (error) {
            logger.error("Error adding reaction:", error);
        }

        const ticket = getTicketByOriginalTs(messageTs);
        if (ticket) {
            const success = await resolveTicket(ticket.ticketMessageTs, userId || "AI-resolved", client, logger, true);
            if (success) {
                logger.info(`Ticket ${ticket.ticketMessageTs} resolved by AI answer marked by user ${userId}`);
            }
        }
    } catch (error) {
        logger.error("Error in ai_mark_resolved:", error);
    }
});

// Listen for reaction added events to resolve tickets
app.event('reaction_added', async ({ event, client, logger }) => {
    const reactionEvent = event as ReactionEvent;

    // Skip if user is not a member of the tickets channel
    if (!isTicketChannelMember(reactionEvent.user)) {
        logger.info(`User ${reactionEvent.user} tried to resolve a ticket via reaction but is not in the tickets channel`);
        return;
    }

    // Check for the check mark reaction in the help channel
    if (reactionEvent.reaction === 'white_check_mark' && reactionEvent.item.channel === HELP_CHANNEL) {

        const replies = await client.conversations.replies({
            channel: HELP_CHANNEL,
            ts: event.item.ts,
        });

        const thread = replies.messages;
        if (!thread) return;

        await storeThread(thread);

        // Get the ticket by its original timestamp
        const ticket = getTicketByOriginalTs(reactionEvent.item.ts);
        if (!ticket) return;

        // Allow resolving if:
        // 1. User is the original message author, OR
        // 2. User is in the tickets channel
        try {
            // Get the original message to check the author
            const messageInfo = await client.conversations.history({
                channel: reactionEvent.item.channel,
                latest: reactionEvent.item.ts,
                limit: 1,
                inclusive: true
            });

            const isOriginalAuthor = messageInfo.messages &&
                messageInfo.messages[0] &&
                messageInfo.messages[0].user === reactionEvent.user;

            if (isOriginalAuthor || isTicketChannelMember(reactionEvent.user)) {
                const success = await resolveTicket(ticket.ticketMessageTs, reactionEvent.user, client, logger);
                if (success) {
                    logger.info(`Ticket resolved via reaction by ${reactionEvent.user} (${isOriginalAuthor ? 'original author' : 'support team member'})`);
                    try {
                        client.reactions.add({
                            name: "white_check_mark",
                            timestamp: reactionEvent.item.ts,
                            channel: reactionEvent.item.channel,
                        });
                    } catch (error) {
                        logger.error("Error adding reaction:", error);
                    }
                }
            } else {
                logger.info(`User ${reactionEvent.user} tried to resolve a ticket via reaction but is not authorized`);
            }
        } catch (error) {
            logger.error("Error checking message author:", error);
        }
    }
});

// Fetch AI response from the Hack Club AI service
async function fetchAIResponse(userInput: string) {
    try {
        const response = await fetch(AI_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'user', content: userInput }],
                stream: false
            })
        });

        if (!response.ok) { throw new Error("Failed to fetch AI response"); }

        interface AIChoice { message?: { content?: string } }
        interface AIResponse { choices?: AIChoice[] }

        const data = await response.json() as AIResponse;
        return data.choices?.[0]?.message?.content ?? "Error: No response content";

    } catch (error) {
        return `Error: ${error}`;
    }
}
async function sendLB() {
    app.client.chat.postMessage({
        channel: TICKETS_CHANNEL,
        text: `Todays top 10 for ticket closes:\n${lbForToday.sort((a, b) => b.count_of_tickets - a.count_of_tickets).map((e, i) => `${i + 1} - <@${e.slack_id}> resolved *${e.count_of_tickets}* today!\n`)}`
    })
    lbForToday = []
    saveTicketData()
}

const storeThread = async (thread: MessageElement[]) => {
    const qas = await parseQAs(thread);
    if (!qas || qas.length === 0) return;

    for (const qa of qas) {
        const embedding = await generateEmbedding(qa.question);
        if (!embedding) continue;

        const question = qa.question;
        const answer = qa.answer;
        const citations = qa.citations;

        // Store citation content and get citation IDs
        const citationIds = [];

        for (const c of citations) {
            const messageIndex = c - 1;
            if (!thread[messageIndex] || !thread[messageIndex].ts) continue;

            const message = thread[messageIndex];
            const messageTs = message.ts!;
            const content = extractPlaintextFromMessage(message);

            // Get username from either the real_name, name, or user_id
            let username = "Unknown User";
            if (message.user) {
                try {
                    // Try to get user info
                    const userInfo = await app.client.users.info({
                        user: message.user,
                    });

                    if (userInfo.user) {
                        username =
                            userInfo.user.real_name || userInfo.user.name || message.user;
                    } else {
                        username = message.user;
                    }
                } catch (error) {
                    console.error("Error fetching user info:", error);
                    username = message.user;
                }
            }

            const permalinkRes = await app.client.chat.getPermalink({
                channel: HELP_CHANNEL,
                message_ts: messageTs,
            });

            const permalink = permalinkRes.permalink!;

            // Insert citation into citations table
            const [citationRecord] = await db
                .insert(citationsTable)
                .values({
                    permalink,
                    content: content || "No content available",
                    timestamp: messageTs,
                    username,
                })
                .returning({ id: citationsTable.id });

            if (citationRecord) {
                citationIds.push(citationRecord.id);
            }
        }

        // Insert question with citation IDs
        await db.insert(questionsTable).values({
            question,
            answer,
            citationIds,
            embedding,
        });

        console.log("Stored question:", question);
    }
};

// Start the app
(async () => {

    const previousMessages = await app.client.conversations.history({
        channel: HELP_CHANNEL,
    });

    for (const msg of previousMessages.messages ?? []) {
        if (msg.reactions && msg.reactions.length > 0) {
            if (msg.reactions.some((r) => r.name === "white_check_mark")) {
                if (!msg.ts) continue;

                const replies = await app.client.conversations.replies({
                    channel: HELP_CHANNEL,
                    ts: msg.ts,
                });

                const thread = replies.messages;
                if (!thread) continue;

                await storeThread(thread);
            }
        }
    }

    // Load ticket data from file before starting the app
    await loadTicketData();

    await app.start();

    // Initialize the ticket channel members cache
    const client = app.client;
    await refreshTicketChannelMembers(client);

    // Refresh the ticket channel members list every hour
    setInterval(() => refreshTicketChannelMembers(client), 60 * 60 * 1000);

    // Periodically save ticket data (every 5 minutes as a backup)
    setInterval(saveTicketData, 5 * 60 * 1000);

    // interval to send lb
    setInterval(sendLB, 24 * 60 * 60 * 1000)
    console.log(`⚡️ Slack Bolt app is running!`);
})();