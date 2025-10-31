import { MCPServer } from "@mastra/mcp"
import { 
  analyzeRepoTool,
  createPRTool,
  searchGitHubIssues,
  runTestsTool,
  analyzeCodeQuality,
  generateFixTool
} from "../tools";
import { repoSageAgent } from "../agents";

export const server = new MCPServer({
  name: "RepoSage Server",
  version: "1.0.0",
  tools: { 
    analyzeRepoTool,
    createPRTool,
    searchGitHubIssues,
    runTestsTool,
    analyzeCodeQuality,
    generateFixTool
  },
  agents: { repoSageAgent }, // this agent will become tool "ask_repoSageAgent"
});
