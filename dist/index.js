#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client as HubSpotClient } from "@hubspot/api-client";
import * as dotenv from "dotenv";
import { McpError, ErrorCode, CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
// Load environment variables from .env file
dotenv.config();
// Provide fallback dummy values for local testing
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN || "dummy_access_token";
const SHARED_CONTACT_ID = process.env.SHARED_CONTACT_ID || "dummy_contact_id";
// Keep STDIN open so the container does not exit when using stdio transport
process.stdin.resume();
class HubSpotMcpServer {
    server;
    hubspotClient;
    constructor() {
        // Initialize the MCP server with metadata and a list of tools.
        this.server = new Server({
            name: "hubspot-mcp-server",
            version: "0.1.0",
            description: "A HubSpot integration server that creates, retrieves, updates, and deletes summary notes.\n" +
                "Tools include:\n" +
                "  • create_shared_summary: Create a note using title, summary, and author.\n" +
                "  • get_summaries: Retrieve notes with flexible filters (date, dayOfWeek, limit, timeRange).\n" +
                "  • update_shared_summary: Update a note by Engagement ID or search query.\n" +
                "  • delete_shared_summary: Delete a note by Engagement ID or via filters.",
        }, {
            capabilities: { tools: {} },
        });
        // Initialize HubSpot API client.
        this.hubspotClient = new HubSpotClient({
            accessToken: HUBSPOT_ACCESS_TOKEN,
        });
        this.setupToolHandlers();
        // Global error handling.
        this.server.onerror = (error) => console.error("[MCP Error]", error);
        process.on("SIGINT", async () => {
            await this.server.close();
            process.exit(0);
        });
    }
    setupToolHandlers() {
        // Handle list tools request
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "create_shared_summary",
                    description: "Create a summary note with title, summary, and author",
                    inputSchema: {
                        type: "object",
                        properties: {
                            title: { type: "string", description: "Title of the summary" },
                            summary: { type: "string", description: "Content of the summary" },
                            author: { type: "string", description: "Name of the author" },
                        },
                        required: ["title", "summary", "author"],
                    },
                },
                {
                    name: "get_summaries",
                    description: "Retrieve summary notes with optional filters",
                    inputSchema: {
                        type: "object",
                        properties: {
                            date: { type: "string", description: "Optional: Date in YYYY-MM-DD format" },
                            dayOfWeek: { type: "string", description: "Optional: Day of the week (e.g., Monday)" },
                            limit: { type: "number", description: "Optional: Number of summaries to return" },
                            timeRange: {
                                type: "object",
                                properties: {
                                    start: { type: "string", description: "Optional: Start time in HH:MM" },
                                    end: { type: "string", description: "Optional: End time in HH:MM" },
                                },
                                description: "Optional: Time range filter",
                            },
                        },
                    },
                },
                {
                    name: "update_shared_summary",
                    description: "Update an existing summary note",
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: { type: "string", description: "Optional: Engagement ID of the note" },
                            query: { type: "string", description: "Optional: Keyword to search in note content" },
                            title: { type: "string", description: "Optional: Updated title" },
                            summary: { type: "string", description: "Optional: Updated content" },
                            author: { type: "string", description: "Optional: Updated author" },
                        },
                    },
                },
                {
                    name: "delete_shared_summary",
                    description: "Delete a summary note",
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: { type: "string", description: "Optional: Engagement ID to delete" },
                            date: { type: "string", description: "Optional: Date in YYYY-MM-DD format" },
                            dayOfWeek: { type: "string", description: "Optional: Day of the week (e.g., Monday)" },
                            limit: { type: "number", description: "Optional: Number of summaries to consider (default 1)" },
                            timeRange: {
                                type: "object",
                                properties: {
                                    start: { type: "string", description: "Optional: Start time in HH:MM" },
                                    end: { type: "string", description: "Optional: End time in HH:MM" },
                                },
                                description: "Optional: Time range filter",
                            },
                        },
                    },
                },
            ],
        }));
        // Dispatch tool calls based on tool name.
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            switch (request.params.name) {
                case "create_shared_summary":
                    return await this.handleCreateSharedSummary(request.params.arguments);
                case "get_summaries":
                    return await this.handleGetSummaries(request.params.arguments);
                case "update_shared_summary":
                    return await this.handleUpdateSharedSummary(request.params.arguments);
                case "delete_shared_summary":
                    return await this.handleDeleteSharedSummary(request.params.arguments);
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }
        });
    }
    async handleCreateSharedSummary({ title, summary, author }) {
        try {
            const noteBody = `Title: ${title}\nSummary: ${summary}\nAuthor: ${author}`;
            const res = await fetch("https://api.hubapi.com/engagements/v1/engagements", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
                },
                body: JSON.stringify({
                    engagement: { active: true, type: "NOTE", timestamp: new Date().getTime() },
                    associations: { contactIds: [parseInt(SHARED_CONTACT_ID)] },
                    metadata: { body: noteBody },
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(`HTTP-Code: ${res.status}\nMessage: ${data.message}`);
            }
            return { content: [{ type: "text", text: `Summary created successfully. Engagement ID: ${data.engagement.id}` }] };
        }
        catch (error) {
            console.error("Error creating summary:", error);
            return { content: [{ type: "text", text: `Error creating summary: ${error.message || "Unknown error"}` }], isError: true };
        }
    }
    async handleGetSummaries({ date, dayOfWeek, limit, timeRange }) {
        try {
            const res = await fetch("https://api.hubapi.com/engagements/v1/engagements/paged?limit=100", {
                method: "GET",
                headers: { "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}` },
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(`HTTP-Code: ${res.status}\nMessage: ${data.message}`);
            }
            let results = data.results;
            if (date) {
                results = results.filter((record) => {
                    const ts = record.engagement.timestamp;
                    return new Date(ts).toISOString().split("T")[0] === date;
                });
            }
            if (dayOfWeek) {
                const dayMap = {
                    sunday: 0,
                    monday: 1,
                    tuesday: 2,
                    wednesday: 3,
                    thursday: 4,
                    friday: 5,
                    saturday: 6,
                };
                const targetDay = dayMap[dayOfWeek.toLowerCase()];
                if (targetDay === undefined) {
                    throw new Error(`Invalid dayOfWeek provided: ${dayOfWeek}`);
                }
                results = results.filter((record) => {
                    const ts = record.engagement.timestamp;
                    return new Date(ts).getDay() === targetDay;
                });
            }
            if (timeRange && timeRange.start && timeRange.end) {
                results = results.filter((record) => {
                    const ts = record.engagement.timestamp;
                    const dateObj = new Date(ts);
                    const pad = (n) => n.toString().padStart(2, "0");
                    const currentTime = `${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
                    return currentTime >= timeRange.start && currentTime <= timeRange.end;
                });
            }
            results.sort((a, b) => b.engagement.timestamp - a.engagement.timestamp);
            if (limit && limit > 0) {
                results = results.slice(0, limit);
            }
            return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
        }
        catch (error) {
            console.error("Error retrieving summaries:", error);
            return { content: [{ type: "text", text: `Error retrieving summaries: ${error.message}` }], isError: true };
        }
    }
    async handleUpdateSharedSummary({ id, query, title, summary, author }) {
        try {
            let targetId = id;
            if (!targetId && query) {
                const res = await fetch("https://api.hubapi.com/engagements/v1/engagements/paged?limit=100", {
                    method: "GET",
                    headers: { "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}` },
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(`HTTP-Code: ${res.status}\nMessage: ${data.message}`);
                }
                let candidates = data.results.filter((record) => {
                    const body = record.metadata.body || "";
                    return body.toLowerCase().includes(query.toLowerCase());
                });
                candidates.sort((a, b) => b.engagement.timestamp - a.engagement.timestamp);
                if (candidates.length === 0) {
                    throw new Error("No summary found matching the provided query.");
                }
                targetId = candidates[0].engagement.id;
            }
            if (!targetId) {
                throw new Error("Please provide an Engagement ID or a search query to locate the summary note.");
            }
            const getRes = await fetch(`https://api.hubapi.com/engagements/v1/engagements/${targetId}`, {
                method: "GET",
                headers: { "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}` },
            });
            const getData = await getRes.json();
            if (!getRes.ok) {
                throw new Error(`HTTP-Code: ${getRes.status}\nMessage: ${getData.message}`);
            }
            const currentBody = getData.metadata.body;
            let currentTitle = "";
            let currentSummary = "";
            let currentAuthor = "";
            const lines = currentBody.split("\n");
            lines.forEach((line) => {
                if (line.startsWith("Title: ")) {
                    currentTitle = line.replace("Title: ", "");
                }
                else if (line.startsWith("Summary: ")) {
                    currentSummary = line.replace("Summary: ", "");
                }
                else if (line.startsWith("Author: ")) {
                    currentAuthor = line.replace("Author: ", "");
                }
            });
            const newTitle = title || currentTitle;
            const newSummary = summary || currentSummary;
            const newAuthor = author || currentAuthor;
            const updatedBody = `Title: ${newTitle}\nSummary: ${newSummary}\nAuthor: ${newAuthor}`;
            const resUpdate = await fetch(`https://api.hubapi.com/engagements/v1/engagements/${targetId}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
                },
                body: JSON.stringify({ metadata: { body: updatedBody } }),
            });
            const dataUpdate = await resUpdate.json();
            if (!resUpdate.ok) {
                throw new Error(`HTTP-Code: ${resUpdate.status}\nMessage: ${dataUpdate.message}`);
            }
            return { content: [{ type: "text", text: `Summary updated successfully. Engagement ID: ${dataUpdate.engagement.id}` }] };
        }
        catch (error) {
            console.error("Error updating summary:", error);
            return { content: [{ type: "text", text: `Error updating summary: ${error.message}` }], isError: true };
        }
    }
    async handleDeleteSharedSummary({ id, date, dayOfWeek, limit, timeRange }) {
        try {
            let targetId = id;
            if (!targetId) {
                const res = await fetch("https://api.hubapi.com/engagements/v1/engagements/paged?limit=100", {
                    method: "GET",
                    headers: { "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}` },
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(`HTTP-Code: ${res.status}\nMessage: ${data.message}`);
                }
                let results = data.results;
                if (date) {
                    results = results.filter((record) => {
                        const ts = record.engagement.timestamp;
                        return new Date(ts).toISOString().split("T")[0] === date;
                    });
                }
                if (dayOfWeek) {
                    const dayMap = {
                        sunday: 0,
                        monday: 1,
                        tuesday: 2,
                        wednesday: 3,
                        thursday: 4,
                        friday: 5,
                        saturday: 6,
                    };
                    const targetDay = dayMap[dayOfWeek.toLowerCase()];
                    if (targetDay === undefined) {
                        throw new Error(`Invalid dayOfWeek provided: ${dayOfWeek}`);
                    }
                    results = results.filter((record) => {
                        const ts = record.engagement.timestamp;
                        return new Date(ts).getDay() === targetDay;
                    });
                }
                if (timeRange && timeRange.start && timeRange.end) {
                    results = results.filter((record) => {
                        const ts = record.engagement.timestamp;
                        const dateObj = new Date(ts);
                        const pad = (n) => n.toString().padStart(2, "0");
                        const currentTime = `${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
                        return currentTime >= timeRange.start && currentTime <= timeRange.end;
                    });
                }
                results.sort((a, b) => b.engagement.timestamp - a.engagement.timestamp);
                const n = (limit && limit > 0) ? limit : 1;
                const candidate = results.slice(0, n);
                if (candidate.length === 0) {
                    throw new Error("No summary found matching the provided filters.");
                }
                targetId = candidate[0].engagement.id;
            }
            const resDelete = await fetch(`https://api.hubapi.com/engagements/v1/engagements/${targetId}`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}` },
            });
            if (!resDelete.ok) {
                const deleteData = await resDelete.json();
                throw new Error(`HTTP-Code: ${resDelete.status}\nMessage: ${deleteData.message}`);
            }
            return { content: [{ type: "text", text: `Summary deleted successfully. Engagement ID: ${targetId}` }] };
        }
        catch (error) {
            console.error("Error deleting summary:", error);
            return { content: [{ type: "text", text: `Error deleting summary: ${error.message}` }], isError: true };
        }
    }
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("HubSpot MCP server running on stdio");
        // Immediately send an initialization message to advertise capabilities
        const initMessage = {
            type: "init",
            tools: [
                {
                    name: "create_shared_summary",
                    description: "Create a summary note with title, summary, and author",
                    inputSchema: {
                        type: "object",
                        properties: {
                            title: { type: "string", description: "Title of the summary" },
                            summary: { type: "string", description: "Content of the summary" },
                            author: { type: "string", description: "Name of the author" },
                        },
                        required: ["title", "summary", "author"],
                    },
                },
                {
                    name: "get_summaries",
                    description: "Retrieve summary notes with optional filters",
                    inputSchema: {
                        type: "object",
                        properties: {
                            date: { type: "string", description: "Optional: Date in YYYY-MM-DD format" },
                            dayOfWeek: { type: "string", description: "Optional: Day of the week (e.g., Monday)" },
                            limit: { type: "number", description: "Optional: Number of summaries to return" },
                            timeRange: {
                                type: "object",
                                properties: {
                                    start: { type: "string", description: "Optional: Start time in HH:MM" },
                                    end: { type: "string", description: "Optional: End time in HH:MM" },
                                },
                                description: "Optional: Time range filter",
                            },
                        },
                    },
                },
                {
                    name: "update_shared_summary",
                    description: "Update an existing summary note",
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: { type: "string", description: "Optional: Engagement ID of the note" },
                            query: { type: "string", description: "Optional: Keyword to search in note content" },
                            title: { type: "string", description: "Optional: Updated title" },
                            summary: { type: "string", description: "Optional: Updated content" },
                            author: { type: "string", description: "Optional: Updated author" },
                        },
                    },
                },
                {
                    name: "delete_shared_summary",
                    description: "Delete a summary note",
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: { type: "string", description: "Optional: Engagement ID to delete" },
                            date: { type: "string", description: "Optional: Date in YYYY-MM-DD format" },
                            dayOfWeek: { type: "string", description: "Optional: Day of the week (e.g., Monday)" },
                            limit: { type: "number", description: "Optional: Number of summaries to consider (default 1)" },
                            timeRange: {
                                type: "object",
                                properties: {
                                    start: { type: "string", description: "Optional: Start time in HH:MM" },
                                    end: { type: "string", description: "Optional: End time in HH:MM" },
                                },
                                description: "Optional: Time range filter",
                            },
                        },
                    },
                },
            ]
        };
        process.stdout.write(JSON.stringify(initMessage) + "\n");
    }
}
const server = new HubSpotMcpServer();
server.run().catch(console.error);
