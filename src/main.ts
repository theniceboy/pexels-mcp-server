import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PexelsService } from "./services/pexels-service.js";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

// Create an MCP server
const server = new McpServer({
  name: "PexelsMCP",
  version: "1.0.0",
});

// Initialize Pexels service - API key should be provided via environment variable PEXELS_API_KEY
const pexelsService = new PexelsService();

// --- Photo API Tools ---

// Tool for searching photos
server.tool(
  "searchPhotos",
  {
    query: z.string().describe("The search query. Use descriptive keywords for relevant results (e.g., 'Thai hotel reception', 'red sports car driving', not just 'hotel' or 'car'). Combine with parameters like 'orientation', 'size', and 'color' for refined results."),
    orientation: z.enum(["landscape", "portrait", "square"]).optional().describe("Desired photo orientation"),
    size: z.enum(["large", "medium", "small"]).optional().describe("Minimum photo size"),
    color: z.string().optional().describe("Desired photo color (e.g., 'red', 'blue', '#ff0000')"),
    page: z.number().positive().optional().describe("Page number"),
    perPage: z.number().min(1).max(80).optional().describe("Results per page (max 80)"),
    locale: z.string().optional().describe("The locale of the search query (e.g., 'en-US', 'es-ES')."),
    // download: z.boolean().optional().describe("If true, download the top image and return as a file with attribution") // Download handled by separate tool
  },
  async ({ query, orientation, size, color, page, perPage, locale }) => {
    // Note: The 'download' parameter is kept in the schema for potential future use
    // but the download logic is now handled by the dedicated 'downloadPhoto' tool.
    try {
      const response = await pexelsService.searchPhotos(query, {
        orientation,
        size,
        color,
        locale, // Pass locale
        page,
        per_page: perPage
      });

      const results = response.data; // Access the actual data
      const rateLimit = response.rateLimit; // Get rate limit info

      const content: any[] = [
        {
          type: "text",
          text: `Found ${results.total_results} photos matching "${query}"`
        },
        {
          type: "text", // Return JSON as stringified text
          text: JSON.stringify(results, null, 2)
        }
      ];

      // Add rate limit info if available
      if (rateLimit) {
        const resetDate = rateLimit.reset ? new Date(rateLimit.reset * 1000).toISOString() : 'N/A';
        content.push({
          type: "text",
          text: `\nRate Limit: ${rateLimit.remaining ?? 'N/A'}/${rateLimit.limit ?? 'N/A'} requests remaining this period. Resets at ${resetDate}.`
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching photos: ${(error as Error).message}`
          }
        ]
      };
    }
  }
);

// Tool for downloading a photo by ID
server.tool(
  "downloadPhoto",
  {
    id: z.number().positive().describe("The ID of the photo to download"),
    size: z.enum(['original', 'large2x', 'large', 'medium', 'small', 'portrait', 'landscape', 'tiny'])
           .optional().default('original')
           .describe("Desired photo size/version to download"),
  },
  async ({ id, size }, _extra) => {
    try {
      const response = await pexelsService.getPhoto(id);
      const photo = response.data; // Access the actual data
      const rateLimit = response.rateLimit; // Get rate limit info

      if (!photo) { // Check if data itself is null/undefined (though service should throw 404)
        return {
          content: [
            { type: "text", text: `Photo with ID ${id} not found.` }
          ]
        };
      }
      // Select the URL based on the requested size
      const availableSizes = photo.src;
      let imageUrl = availableSizes[size];
      let actualSize = size;

      // Fallback logic if requested size isn't directly available (though Pexels usually provides all)
      if (!imageUrl) {
        console.warn(`Requested size '${size}' not found for photo ${id}, falling back to 'original'.`);
        imageUrl = availableSizes.original;
        actualSize = 'original';
      }
       if (!imageUrl) { // Final fallback if even original is missing (unlikely)
         return { content: [{ type: "text", text: `Could not find any download URL for photo ID ${id}.` }] };
       }


      const ext = path.extname(new URL(imageUrl).pathname) || ".jpg";
      const fileName = `pexels_${photo.id}_${actualSize}${ext}`; // Include size in filename

      // Return the direct download link instead of fetching data
      const content: any[] = [
        {
          type: "text",
          text: `Download Link (${actualSize}): ${imageUrl}`
        },
        {
          type: "text",
          text: `Suggested Filename: ${fileName}\nAttribution: Photo by ${photo.photographer} (${photo.photographer_url}) on Pexels. License: https://www.pexels.com/license/\n\nRecommendation: Use an available local tool (like curl or PowerShell's Invoke-WebRequest) to download the photo using the link provided.`
        }
      ];

      // Add rate limit info if available
      if (rateLimit) {
        const resetDate = rateLimit.reset ? new Date(rateLimit.reset * 1000).toISOString() : 'N/A';
        content.push({
          type: "text",
          text: `\nRate Limit: ${rateLimit.remaining ?? 'N/A'}/${rateLimit.limit ?? 'N/A'} requests remaining this period. Resets at ${resetDate}.`
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error preparing photo data: ${(error as Error).message}`
          }
        ]
      };
    }
  }
);
// Removed duplicated code section

// Tool for downloading a video by ID
server.tool(
  "downloadVideo",
  {
    id: z.number().positive().describe("The ID of the video to download"),
    quality: z.enum(["hd", "sd"]).optional().default("hd").describe("Preferred video quality (hd or sd)")
  },
  async ({ id, quality }, _extra) => {
    try {
      const response = await pexelsService.getVideo(id);
      const videoData = response.data; // Access the actual data
      const rateLimit = response.rateLimit; // Get rate limit info

      if (!videoData) { // Check if data itself is null/undefined
        return {
          content: [
            { type: "text", text: `Video with ID ${id} not found.` }
          ]
        };
      }

      // Find the video file URL for the desired quality
      // Add type annotation here
      const videoFile = videoData.video_files.find((vf: { quality: string; }) => vf.quality === quality) || videoData.video_files[0]; // Fallback to first available
      if (!videoFile) {
        return {
          content: [
            { type: "text", text: `No video file found for ID ${id}.` }
          ]
        };
      }

      const videoUrl = videoFile.link;
      const ext = path.extname(new URL(videoUrl).pathname) || ".mp4"; // Guess extension
      const fileName = `pexels_video_${videoData.id}_${videoFile.quality}${ext}`;

      // Return the direct download link instead of fetching data
      const content: any[] = [
        {
          type: "text",
          text: `Download Link (${videoFile.quality}): ${videoUrl}`
        },
        {
          type: "text",
          text: `Suggested Filename: ${fileName}\nAttribution: Video by ${videoData.user.name} (${videoData.user.url}) on Pexels. License: https://www.pexels.com/license/\n\nRecommendation: Use an available local tool (like curl or PowerShell's Invoke-WebRequest) to download the video using the link provided.`
        }
      ];

       // Add rate limit info if available
       if (rateLimit) {
        const resetDate = rateLimit.reset ? new Date(rateLimit.reset * 1000).toISOString() : 'N/A';
        content.push({
          type: "text",
          text: `\nRate Limit: ${rateLimit.remaining ?? 'N/A'}/${rateLimit.limit ?? 'N/A'} requests remaining this period. Resets at ${resetDate}.`
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error preparing video data: ${(error as Error).message}`
          }
        ]
      };
    }
  }
);

// Tool for getting curated photos
server.tool(
  "getCuratedPhotos",
  {
    page: z.number().positive().optional().describe("Page number"),
    perPage: z.number().min(1).max(80).optional().describe("Results per page (max 80)")
  },
  async ({ page, perPage }: { page?: number, perPage?: number }) => { // Added explicit types
    try {
      const response = await pexelsService.getCuratedPhotos({
        page,
        per_page: perPage
      });

      const results = response.data; // Access the actual data
      const rateLimit = response.rateLimit; // Get rate limit info
      
      const content: any[] = [
        {
          type: "text",
          text: `Retrieved ${results.photos.length} curated photos`
        },
        {
          type: "text",
          text: JSON.stringify(results, null, 2)
        }
      ];

      // Add rate limit info if available
      if (rateLimit) {
        const resetDate = rateLimit.reset ? new Date(rateLimit.reset * 1000).toISOString() : 'N/A';
        content.push({
          type: "text",
          text: `\nRate Limit: ${rateLimit.remaining ?? 'N/A'}/${rateLimit.limit ?? 'N/A'} requests remaining this period. Resets at ${resetDate}.`
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          {
            type: "text", 
            text: `Error getting curated photos: ${(error as Error).message}`
          }
        ]
      };
    }
  }
);

// Tool for getting a specific photo by ID
server.tool(
  "getPhoto", 
  { 
    id: z.number().positive().describe("The ID of the photo to retrieve")
  }, 
  async ({ id }) => {
    try {
      const response = await pexelsService.getPhoto(id);
      const photo = response.data; // Access the actual data
      const rateLimit = response.rateLimit; // Get rate limit info

      if (!photo) {
         return { content: [{ type: "text", text: `Photo with ID ${id} not found.` }] };
      }
      
      const content: any[] = [
        {
          type: "text",
          text: `Retrieved photo: ${photo.alt || photo.url}`
        },
        {
          type: "text",
          text: JSON.stringify(photo, null, 2)
        }
      ];

      // Add rate limit info if available
      if (rateLimit) {
        const resetDate = rateLimit.reset ? new Date(rateLimit.reset * 1000).toISOString() : 'N/A';
        content.push({
          type: "text",
          text: `\nRate Limit: ${rateLimit.remaining ?? 'N/A'}/${rateLimit.limit ?? 'N/A'} requests remaining this period. Resets at ${resetDate}.`
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `Error getting photo: ${(error as Error).message}`
          }
        ]
      };
    }
  }
);

// --- Video API Tools ---

// Tool for searching videos
server.tool(
  "searchVideos", 
  { 
    query: z.string().describe("The search query. Use descriptive keywords for relevant results (e.g., 'drone footage beach sunset', 'time lapse city traffic', not just 'beach' or 'city'). Combine with parameters like 'orientation' and 'size' for refined results."),
    orientation: z.enum(["landscape", "portrait", "square"]).optional().describe("Desired video orientation"),
    size: z.enum(["large", "medium", "small"]).optional().describe("Minimum video size"),
    page: z.number().positive().optional().describe("Page number"),
    perPage: z.number().min(1).max(80).optional().describe("Results per page (max 80)"),
    locale: z.string().optional().describe("The locale of the search query (e.g., 'en-US', 'es-ES').")
  },
  async ({ query, orientation, size, page, perPage, locale }) => {
    try {
      const response = await pexelsService.searchVideos(query, {
        orientation,
        size,
        locale, // Pass locale
        page,
        per_page: perPage
      });

      const results = response.data; // Access the actual data
      const rateLimit = response.rateLimit; // Get rate limit info
      
      const content: any[] = [
        {
          type: "text",
          text: `Found ${results.total_results} videos matching "${query}"`
        },
        {
          type: "text",
          text: JSON.stringify(results, null, 2)
        }
      ];

      // Add rate limit info if available
      if (rateLimit) {
        const resetDate = rateLimit.reset ? new Date(rateLimit.reset * 1000).toISOString() : 'N/A';
        content.push({
          type: "text",
          text: `\nRate Limit: ${rateLimit.remaining ?? 'N/A'}/${rateLimit.limit ?? 'N/A'} requests remaining this period. Resets at ${resetDate}.`
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `Error searching videos: ${(error as Error).message}`
          }
        ]
      };
    }
  }
);

// Tool for getting popular videos
server.tool(
  "getPopularVideos", 
  { 
    minWidth: z.number().optional().describe("Minimum video width in pixels"),
    minHeight: z.number().optional().describe("Minimum video height in pixels"),
    minDuration: z.number().optional().describe("Minimum video duration in seconds"),
    maxDuration: z.number().optional().describe("Maximum video duration in seconds"),
    page: z.number().positive().optional().describe("Page number"),
    perPage: z.number().min(1).max(80).optional().describe("Results per page (max 80)") 
  }, 
  async ({ minWidth, minHeight, minDuration, maxDuration, page, perPage }) => {
    try {
      const response = await pexelsService.getPopularVideos({
        min_width: minWidth,
        min_height: minHeight,
        min_duration: minDuration,
        max_duration: maxDuration,
        page,
        per_page: perPage
      });

      const results = response.data; // Access the actual data
      const rateLimit = response.rateLimit; // Get rate limit info
      
      const content: any[] = [
        {
          type: "text",
          text: `Retrieved ${results.videos.length} popular videos`
        },
        {
          type: "text",
          text: JSON.stringify(results, null, 2)
        }
      ];

      // Add rate limit info if available
      if (rateLimit) {
        const resetDate = rateLimit.reset ? new Date(rateLimit.reset * 1000).toISOString() : 'N/A';
        content.push({
          type: "text",
          text: `\nRate Limit: ${rateLimit.remaining ?? 'N/A'}/${rateLimit.limit ?? 'N/A'} requests remaining this period. Resets at ${resetDate}.`
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `Error getting popular videos: ${(error as Error).message}`
          }
        ]
      };
    }
  }
);

// Tool for getting a specific video by ID
server.tool(
  "getVideo", 
  { 
    id: z.number().positive().describe("The ID of the video to retrieve")
  }, 
  async ({ id }) => {
    try {
      const response = await pexelsService.getVideo(id);
      const video = response.data; // Access the actual data
      const rateLimit = response.rateLimit; // Get rate limit info

      if (!video) {
        return { content: [{ type: "text", text: `Video with ID ${id} not found.` }] };
      }
      
      const content: any[] = [
        {
          type: "text",
          text: `Retrieved video with ID: ${id}`
        },
        {
          type: "text",
          text: JSON.stringify(video, null, 2)
        }
      ];

      // Add rate limit info if available
      if (rateLimit) {
        const resetDate = rateLimit.reset ? new Date(rateLimit.reset * 1000).toISOString() : 'N/A';
        content.push({
          type: "text",
          text: `\nRate Limit: ${rateLimit.remaining ?? 'N/A'}/${rateLimit.limit ?? 'N/A'} requests remaining this period. Resets at ${resetDate}.`
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `Error getting video: ${(error as Error).message}`
          }
        ]
      };
    }
  }
);

// --- Collections API Tools ---

// Tool for getting featured collections
server.tool(
  "getFeaturedCollections", 
  { 
    page: z.number().positive().optional().describe("Page number"),
    perPage: z.number().min(1).max(80).optional().describe("Results per page (max 80)") 
  }, 
  async ({ page, perPage }) => {
    try {
      const response = await pexelsService.getFeaturedCollections({
        page,
        per_page: perPage
      });

      const collections = response.data; // Access the actual data
      const rateLimit = response.rateLimit; // Get rate limit info
      
      const content: any[] = [
        {
          type: "text",
          text: `Retrieved ${collections.collections.length} featured collections`
        },
        {
          type: "text",
          text: JSON.stringify(collections, null, 2)
        }
      ];

      // Add rate limit info if available
      if (rateLimit) {
        const resetDate = rateLimit.reset ? new Date(rateLimit.reset * 1000).toISOString() : 'N/A';
        content.push({
          type: "text",
          text: `\nRate Limit: ${rateLimit.remaining ?? 'N/A'}/${rateLimit.limit ?? 'N/A'} requests remaining this period. Resets at ${resetDate}.`
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `Error getting featured collections: ${(error as Error).message}`
          }
        ]
      };
    }
  }
);

/*
// NOTE: Accessing user-specific collections ('My Collections') typically requires
// OAuth 2.0 authentication with Pexels, which is not implemented here.
// This tool will likely only work if Pexels allows API key access to this endpoint,
// or it might return an error or empty results without proper user authentication.
// Tool for getting user's collections - Commented out due to auth requirements.
server.tool(
  "getMyCollections",
  {
    page: z.number().positive().optional().describe("Page number"),
    perPage: z.number().min(1).max(80).optional().describe("Results per page (max 80)")
  },
  async ({ page, perPage }) => {
    try {
      const collections = await pexelsService.getMyCollections({
        page,
        per_page: perPage
      });

      return {
        content: [
          {
            type: "text",
            text: `Retrieved ${collections.collections.length} of your collections`
          },
          {
            type: "text",
            text: JSON.stringify(collections, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting your collections: ${(error as Error).message}`
          }
        ]
      };
    }
  }
);
*/

// Tool for getting media from a collection
server.tool(
  "getCollectionMedia", 
  { 
    id: z.string().describe("The ID of the collection"),
    type: z.enum(["photos", "videos"]).optional().describe("Filter by media type"),
    sort: z.enum(["asc", "desc"]).optional().describe("Sort order"),
    page: z.number().positive().optional().describe("Page number"),
    perPage: z.number().min(1).max(80).optional().describe("Results per page (max 80)") 
  }, 
  async ({ id, type, sort, page, perPage }) => {
    try {
      const response = await pexelsService.getCollectionMedia(id, {
        type,
        sort,
        page,
        per_page: perPage
      });

      const media = response.data; // Access the actual data
      const rateLimit = response.rateLimit; // Get rate limit info
      
      const content: any[] = [
        {
          type: "text",
          text: `Retrieved ${media.media.length} media items from collection ${id}`
        },
        {
          type: "text",
          text: JSON.stringify(media, null, 2)
        }
      ];

      // Add rate limit info if available
      if (rateLimit) {
        const resetDate = rateLimit.reset ? new Date(rateLimit.reset * 1000).toISOString() : 'N/A';
        content.push({
          type: "text",
          text: `\nRate Limit: ${rateLimit.remaining ?? 'N/A'}/${rateLimit.limit ?? 'N/A'} requests remaining this period. Resets at ${resetDate}.`
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `Error getting collection media: ${(error as Error).message}`
          }
        ]
      };
    }
  }
);

// --- Photo Resources ---

// Resource for accessing photos by ID
server.resource(
  "photo",
  new ResourceTemplate("pexels-photo://{id}", { list: undefined }),
  async (uri, { id }) => {
    try {
      const photoId = parseInt((id ?? "").toString(), 10);
      if (isNaN(photoId)) {
        return {
          contents: [
            {
              uri: uri.href,
              text: `Invalid photo ID: ${id ?? ""}`,
            },
          ],
        };
      }

      const photo = await pexelsService.getPhoto(photoId);
      
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(photo, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: `Error retrieving photo with ID ${id}: ${(error as Error).message}`,
          },
        ],
      };
    }
  }
);

// --- Video Resources ---

// Resource for accessing videos by ID
server.resource(
  "video",
  new ResourceTemplate("pexels-video://{id}", { list: undefined }),
  async (uri, { id }) => {
    try {
      const videoId = parseInt((id ?? "").toString(), 10);
      if (isNaN(videoId)) {
        return {
          contents: [
            {
              uri: uri.href,
              text: `Invalid video ID: ${id ?? ""}`,
            },
          ],
        };
      }

      const video = await pexelsService.getVideo(videoId);
      
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(video, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: `Error retrieving video with ID ${id}: ${(error as Error).message}`,
          },
        ],
      };
    }
  }
);

// --- Collection Resources ---

// Resource for accessing collections by ID
server.resource(
  "collection",
  new ResourceTemplate("pexels-collection://{id}", { list: undefined }),
  async (uri, { id }) => {
    try {
      const media = await pexelsService.getCollectionMedia((id ?? "").toString());
      
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(media, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: `Error retrieving collection with ID ${id}: ${(error as Error).message}`,
          },
        ],
      };
    }
  }
);

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
await server.connect(transport);
