#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client as HubSpotClient } from "@hubspot/api-client";
import dotenv from "dotenv";
import {
  McpError,
  ErrorCode,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Load environment variables from .env file
dotenv.config();

// Ensure necessary environment variables are set
if (!process.env.HUBSPOT_ACCESS_TOKEN) {
  throw new Error("HUBSPOT_ACCESS_TOKEN not found in environment variables");
}
if (!process.env.SHARED_CONTACT_ID) {
  throw new Error("SHARED_CONTACT_ID not found in environment variables");
}

const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const SHARED_CONTACT_ID = process.env.SHARED_CONTACT_ID;

class HubSpotMcpServer {
  private server: Server;
  private hubspotClient: HubSpotClient;

  constructor() {
    // Initialize the MCP server with metadata and a list of tools.
    // Tool descriptions for the Spine AI/LLM client:
    //
    // 1. create_shared_summary:
    //    • Accepts title, summary, and author.
    //    • Combines these into a note body.
    //    • Creates a new HubSpot Note engagement linked to a dedicated contact.
    //
    // 2. get_summaries:
    //    • Retrieves summary notes using flexible filters.
    //    • Optional filters: date (YYYY-MM-DD), dayOfWeek (e.g., "Monday"), limit (number), timeRange ({start, end}).
    //
    // 3. update_shared_summary:
    //    • Updates an existing note.
    //    • Accepts either an explicit Engagement ID or a search query to find a candidate note.
    //    • Merges existing note content with any provided new values.
    //
    // 4. delete_shared_summary:
    //    • Deletes a note.
    //    • Accepts either an explicit Engagement ID or optional filters to locate a candidate note (e.g., "delete my last summary").
    this.server = new Server(
      {
        name: "hubspot-mcp-server",
        version: "0.1.0",
        description:
          "A HubSpot integration server that creates, retrieves, updates, and deletes summary notes.\n" +
          "Tools include:\n" +
          "  • create_shared_summary: Create a note using title, summary, and author.\n" +
          "  • get_summaries: Retrieve notes with flexible filters (date, dayOfWeek, limit, timeRange).\n" +
          "  • update_shared_summary: Update a note by Engagement ID or search query.\n" +
          "  • delete_shared_summary: Delete a note by Engagement ID or via filters.",
      },
      {
        capabilities: { tools: {} },
      }
    );

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

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "create_shared_summary",
          description:
            "Step 1: Accept a title, summary, and author.\n" +
            "Step 2: Combine these into a note body.\n" +
            "Step 3: Create a new HubSpot Note engagement associated with a dedicated contact.",
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
          description:
            "Retrieve summary notes from HubSpot with flexible filters.\n" +
            "Optional filters:\n" +
            "  • date: (YYYY-MM-DD) to filter by a specific date.\n" +
            "  • dayOfWeek: e.g., 'Monday' to filter by day of the week.\n" +
            "  • limit: Number of most recent summaries to return.\n" +
            "  • timeRange: { start: 'HH:MM', end: 'HH:MM' } to filter by time of day.",
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
          description:
            "Step 1: Provide an explicit Engagement ID OR a search query (query) to locate the note.\n" +
            "Step 2: Retrieve the current note content.\n" +
            "Step 3: Merge existing values with any provided updates (title, summary, author).\n" +
            "Step 4: Update the note while preserving unchanged fields.",
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
          description:
            "Delete a summary note from HubSpot.\n" +
            "Either provide an explicit Engagement ID (id) or use optional filters (date, dayOfWeek, limit, timeRange) " +
            "to select a candidate note (e.g., 'delete my last summary').",
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
          return await this.handleCreateSharedSummary(request.params.arguments as { title: string; summary: string; author: string });
        case "get_summaries":
          return await this.handleGetSummaries(request.params.arguments as { date?: string; dayOfWeek?: string; limit?: number; timeRange?: { start: string; end: string } });
        case "update_shared_summary":
          return await this.handleUpdateSharedSummary(request.params.arguments as { id?: string; query?: string; title?: string; summary?: string; author?: string });
        case "delete_shared_summary":
          return await this.handleDeleteSharedSummary(request.params.arguments as { id?: string; date?: string; dayOfWeek?: string; limit?: number; timeRange?: { start: string; end: string } });
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    });
  }

  /**
   * Create a new summary note in HubSpot.
   */
  async handleCreateSharedSummary({ title, summary, author }: { title: string; summary: string; author: string }): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
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
    } catch (error: any) {
      console.error("Error creating summary:", error);
      return { content: [{ type: "text", text: `Error creating summary: ${error.message || "Unknown error"}` }], isError: true };
    }
  }

  /**
   * Retrieve summary notes from HubSpot using flexible filters.
   */
  async handleGetSummaries({ date, dayOfWeek, limit, timeRange }: { date?: string; dayOfWeek?: string; limit?: number; timeRange?: { start: string; end: string } }): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
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
        results = results.filter((record: any) => {
          const ts = record.engagement.timestamp;
          return new Date(ts).toISOString().split("T")[0] === date;
        });
      }

      if (dayOfWeek) {
        const dayMap: { [key: string]: number } = {
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
        results = results.filter((record: any) => {
          const ts = record.engagement.timestamp;
          return new Date(ts).getDay() === targetDay;
        });
      }

      if (timeRange && timeRange.start && timeRange.end) {
        results = results.filter((record: any) => {
          const ts = record.engagement.timestamp;
          const dateObj = new Date(ts);
          const pad = (n: number) => n.toString().padStart(2, "0");
          const currentTime = `${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
          return currentTime >= timeRange.start && currentTime <= timeRange.end;
        });
      }

      results.sort((a: any, b: any) => b.engagement.timestamp - a.engagement.timestamp);

      if (limit && limit > 0) {
        results = results.slice(0, limit);
      }

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (error: any) {
      console.error("Error retrieving summaries:", error);
      return { content: [{ type: "text", text: `Error retrieving summaries: ${error.message}` }], isError: true };
    }
  }

  /**
   * Update an existing summary note.
   * Accepts either an explicit Engagement ID (id) or a search query (query) to find a candidate note.
   * Merges the current note content with provided updates (title, summary, author).
   */
  async handleUpdateSharedSummary({ id, query, title, summary, author }: { id?: string; query?: string; title?: string; summary?: string; author?: string }): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      let targetId: string | undefined = id;

      // If no explicit ID is provided, use the query to search for a matching note.
      if (!targetId && query) {
        const res = await fetch("https://api.hubapi.com/engagements/v1/engagements/paged?limit=100", {
          method: "GET",
          headers: { "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}` },
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(`HTTP-Code: ${res.status}\nMessage: ${data.message}`);
        }
        let candidates = data.results.filter((record: any) => {
          const body = record.metadata.body || "";
          return body.toLowerCase().includes(query.toLowerCase());
        });
        candidates.sort((a: any, b: any) => b.engagement.timestamp - a.engagement.timestamp);
        if (candidates.length === 0) {
          throw new Error("No summary found matching the provided query.");
        }
        targetId = candidates[0].engagement.id;
      }

      if (!targetId) {
        throw new Error("Please provide an Engagement ID or a search query to locate the summary note.");
      }

      // Retrieve the current note.
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
      lines.forEach((line: string) => {
        if (line.startsWith("Title: ")) {
          currentTitle = line.replace("Title: ", "");
        } else if (line.startsWith("Summary: ")) {
          currentSummary = line.replace("Summary: ", "");
        } else if (line.startsWith("Author: ")) {
          currentAuthor = line.replace("Author: ", "");
        }
      });
      const newTitle = title || currentTitle;
      const newSummary = summary || currentSummary;
      const newAuthor = author || currentAuthor;
      const updatedBody = `Title: ${newTitle}\nSummary: ${newSummary}\nAuthor: ${newAuthor}`;

      const resUpdate = await fetch(`https://api.hubspot.com/engagements/v1/engagements/${targetId}`, {
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
    } catch (error: any) {
      console.error("Error updating summary:", error);
      return { content: [{ type: "text", text: `Error updating summary: ${error.message}` }], isError: true };
    }
  }

  /**
   * Delete a summary note.
   * Accepts either an explicit Engagement ID (id) or optional filters (date, dayOfWeek, limit, timeRange)
   * to locate a candidate note (e.g., "delete my last summary").
   */
  async handleDeleteSharedSummary({ id, date, dayOfWeek, limit, timeRange }: { id?: string; date?: string; dayOfWeek?: string; limit?: number; timeRange?: { start: string; end: string } }): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      let targetId: string | undefined = id;

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
          results = results.filter((record: any) => {
            const ts = record.engagement.timestamp;
            return new Date(ts).toISOString().split("T")[0] === date;
          });
        }
        if (dayOfWeek) {
          const dayMap: { [key: string]: number } = {
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
          results = results.filter((record: any) => {
            const ts = record.engagement.timestamp;
            return new Date(ts).getDay() === targetDay;
          });
        }
        if (timeRange && timeRange.start && timeRange.end) {
          results = results.filter((record: any) => {
            const ts = record.engagement.timestamp;
            const dateObj = new Date(ts);
            const pad = (n: number) => n.toString().padStart(2, "0");
            const currentTime = `${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
            return currentTime >= timeRange.start && currentTime <= timeRange.end;
          });
        }
        results.sort((a: any, b: any) => b.engagement.timestamp - a.engagement.timestamp);
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
    } catch (error: any) {
      console.error("Error deleting summary:", error);
      return { content: [{ type: "text", text: `Error deleting summary: ${error.message}` }], isError: true };
    }
  }

  /**
   * Start the MCP server using STDIO transport.
   */
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("HubSpot MCP server running on stdio");
  }
}

const server = new HubSpotMcpServer();
server.run().catch(console.error);
