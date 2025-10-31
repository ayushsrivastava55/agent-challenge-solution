import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import simpleGit from 'simple-git';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execAsync = promisify(exec);

type GitHubRepoIdentifiers = {
  owner: string;
  repo: string;
};

type GitHubPullRequest = {
  title?: string;
  body?: string;
  diff_url?: string;
  comments_url?: string;
  head?: { ref?: string };
  base?: { ref?: string };
};

type GitHubIssueResponse = {
  number?: number;
  html_url?: string;
};

type GitHubCommentResponse = {
  html_url?: string;
};

type GitHubContentFile = {
  content: string;
  size: number;
  encoding: string;
};

type GitHubContentError = {
  message?: string;
};

type GitHubDirectoryItem = {
  name?: string;
  path?: string;
  type?: string;
  size?: number;
};

type GitHubCodeSearchResponse = {
  items?: Array<{ name?: string; path?: string; html_url?: string }>;
  message?: string;
};

type GitHubCommit = {
  commit?: { message?: string };
};

type GitHubWorkflowRun = {
  name?: string;
  status?: string;
  conclusion?: string;
  run_number?: number;
  created_at?: string;
  html_url?: string;
};

type GitHubWorkflowRunsResponse = {
  workflow_runs?: GitHubWorkflowRun[];
  total_count?: number;
};

type OpenAIChatChoice = {
  message?: { content?: string };
};

type OpenAIChatResponse = {
  choices?: OpenAIChatChoice[];
  error?: { message?: string };
};

type OpenAIJsonLabelsResponse = {
  labels?: string[];
};

type NpmOutdatedEntry = {
  current?: string;
  latest?: string;
  type?: string;
};

type NpmAuditVulnerability = {
  name?: string;
  severity?: string;
  title?: string;
};

type ValidSeverity = 'critical' | 'high' | 'moderate' | 'low';

const VALID_SEVERITIES = new Set<ValidSeverity>(['critical', 'high', 'moderate', 'low']);

type GitHubMergeResponse = {
  merged?: boolean;
  sha?: string;
  message?: string;
} & GitHubContentError;

type GitHubWorkflowDispatchResponse = {
  message?: string;
};

function extractRepoIdentifiers(repoUrl: string): GitHubRepoIdentifiers {
  const repoMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!repoMatch) {
    throw new Error('Invalid GitHub URL');
  }

  const [, owner, repo] = repoMatch;
  return {
    owner,
    repo: repo.replace('.git', ''),
  };
}

async function parseJsonSafe<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function parseJsonStringSafe<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

// ============================================================================
// FILE OPERATIONS
// ============================================================================

export const readFileTool = createTool({
  id: 'read-file',
  description: 'Read a specific file from a GitHub repository',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    filePath: z.string().describe('Path to file in repository (e.g., src/index.ts)'),
    branch: z.string().optional().describe('Branch to read from (defaults to main)'),
  }),
  outputSchema: z.object({
    content: z.string(),
    path: z.string(),
    size: z.number(),
    encoding: z.string(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, filePath, branch } = context;
    return await readFileFromRepo(repoUrl, filePath, branch);
  },
});

export const aiImprovePRTool = createTool({
  id: 'ai-improve-pr',
  description: 'Suggest code improvements for a pull request (non-destructive, publishes as comment optionally)',
  inputSchema: z.object({
    repoUrl: z.string(),
    prNumber: z.number(),
    publish: z.boolean().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    suggestions: z.string(),
    model: z.string(),
    publishedUrl: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, prNumber, publish } = context;
    return await aiImprovePullRequest(repoUrl, prNumber, publish === true);
  },
});

export const aiAskPRTool = createTool({
  id: 'ai-ask-pr',
  description: 'Ask a question about a pull request and get an AI answer',
  inputSchema: z.object({
    repoUrl: z.string(),
    prNumber: z.number(),
    question: z.string(),
    publish: z.boolean().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    answer: z.string(),
    model: z.string(),
    publishedUrl: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, prNumber, question, publish } = context;
    return await aiAskPullRequest(repoUrl, prNumber, question, publish === true);
  },
});

export const generatePRLabelsTool = createTool({
  id: 'generate-pr-labels',
  description: 'Generate and apply labels to a PR using AI (adds labels to the PR)',
  inputSchema: z.object({
    repoUrl: z.string(),
    prNumber: z.number(),
    maxLabels: z.number().optional().describe('Max labels to apply (default 3)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    labels: z.array(z.string()),
  }),
  execute: async ({ context }) => {
    const { repoUrl, prNumber, maxLabels } = context;
    return await generateAndApplyLabels(repoUrl, prNumber, maxLabels ?? 3);
  },
});

export const updateChangelogTool = createTool({
  id: 'update-changelog',
  description: 'Draft a CHANGELOG entry for a PR (publishes as a PR comment when publish=true)',
  inputSchema: z.object({
    repoUrl: z.string(),
    prNumber: z.number(),
    publish: z.boolean().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    changelog: z.string(),
    model: z.string(),
    publishedUrl: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, prNumber, publish } = context;
    return await aiDraftChangelog(repoUrl, prNumber, publish === true);
  },
});

export const aiDescribePRTool = createTool({
  id: 'ai-describe-pr',
  description: 'Generate an improved PR title and description using AI',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    prNumber: z.number().describe('Pull request number'),
    publish: z.boolean().optional().describe('Update PR title/body if true (requires write token)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    title: z.string(),
    description: z.string(),
    model: z.string(),
    published: z.boolean().optional(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, prNumber, publish } = context;
    return await aiDescribePullRequest(repoUrl, prNumber, publish === true);
  },
});

export const listRepoFilesTool = createTool({
  id: 'list-repo-files',
  description: 'List files/directories at a path in a GitHub repository',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    path: z.string().optional().describe('Directory path to list (defaults to root)'),
    branch: z.string().optional().describe('Branch to read from (defaults to repo default)'),
  }),
  outputSchema: z.object({
    items: z.array(z.object({
      name: z.string(),
      path: z.string(),
      type: z.enum(['file', 'dir']),
      size: z.number().optional(),
    })),
  }),
  execute: async ({ context }) => {
    const { repoUrl, path, branch } = context;
    return await listFilesFromRepo(repoUrl, path || '', branch);
  },
});

export const findFileTool = createTool({
  id: 'find-file',
  description: 'Find files in a GitHub repository by name using GitHub code search',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    query: z.string().describe('Filename or search query (e.g., package.json or filename:index.tsx)'),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      name: z.string(),
      path: z.string(),
      htmlUrl: z.string(),
    })),
  }),
  execute: async ({ context }) => {
    const { repoUrl, query } = context;
    return await findFileInRepo(repoUrl, query);
  },
});


// ============================================================================
// ISSUE MANAGEMENT
// ============================================================================

export const createIssueTool = createTool({
  id: 'create-issue',
  description: 'Create a new issue on GitHub',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    title: z.string().describe('Issue title'),
    body: z.string().describe('Issue description'),
    labels: z.array(z.string()).optional().describe('Labels to add (e.g., ["bug", "urgent"])'),
  }),
  outputSchema: z.object({
    issueNumber: z.number(),
    issueUrl: z.string(),
    success: z.boolean(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, title, body, labels } = context;
    return await createGitHubIssue(repoUrl, title, body, labels);
  },
});

export const commentOnIssueTool = createTool({
  id: 'comment-on-issue',
  description: 'Add a comment to an existing issue or PR',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    issueNumber: z.number().describe('Issue or PR number'),
    comment: z.string().describe('Comment text'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    commentUrl: z.string(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, issueNumber, comment } = context;
    return await commentOnGitHubIssue(repoUrl, issueNumber, comment);
  },
});

export const closeIssueTool = createTool({
  id: 'close-issue',
  description: 'Close an issue on GitHub',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    issueNumber: z.number().describe('Issue number to close'),
    comment: z.string().optional().describe('Optional closing comment'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, issueNumber, comment } = context;
    return await closeGitHubIssue(repoUrl, issueNumber, comment);
  },
});

// ============================================================================
// DEPENDENCY MANAGEMENT
// ============================================================================

export const checkDependenciesTool = createTool({
  id: 'check-dependencies',
  description: 'Check for outdated dependencies and security vulnerabilities',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
  }),
  outputSchema: z.object({
    outdated: z.array(z.object({
      name: z.string(),
      current: z.string(),
      latest: z.string(),
      type: z.enum(['dependencies', 'devDependencies']),
    })),
    vulnerabilities: z.array(z.object({
      name: z.string(),
      severity: z.enum(['critical', 'high', 'moderate', 'low']),
      description: z.string(),
    })),
    summary: z.string(),
  }),
  execute: async ({ context }) => {
    const { repoUrl } = context;
    return await checkDependencies(repoUrl);
  },
});


// ============================================================================
// CODE FORMATTING & QUALITY
// ============================================================================

export const formatCodeTool = createTool({
  id: 'format-code',
  description: 'Run code formatter (Prettier) on repository',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    files: z.array(z.string()).optional().describe('Specific files to format (formats all if not specified)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    filesFormatted: z.number(),
    changes: z.array(z.string()),
  }),
  execute: async ({ context }) => {
    const { repoUrl, files } = context;
    return await formatCode(repoUrl, files);
  },
});

export const fixLintErrorsTool = createTool({
  id: 'fix-lint-errors',
  description: 'Automatically fix lint errors using ESLint --fix',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    errorsFixed: z.number(),
    remainingErrors: z.number(),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    const { repoUrl } = context;
    return await fixLintErrors(repoUrl);
  },
});

// ============================================================================
// BRANCH & COMMIT OPERATIONS
// ============================================================================



// ============================================================================
// PR OPERATIONS
// ============================================================================


export const mergePRTool = createTool({
  id: 'merge-pr',
  description: 'Merge a pull request',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    prNumber: z.number().describe('PR number to merge'),
    mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge method (defaults to merge)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    merged: z.boolean(),
    sha: z.string(),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, prNumber, mergeMethod } = context;
    return await mergePullRequest(repoUrl, prNumber, mergeMethod);
  },
});

// ============================================================================
// AI PR REVIEW (inspired by PR-Agent /review)
// ============================================================================

export const aiReviewPRTool = createTool({
  id: 'ai-review-pr',
  description: 'Generate an AI review for a pull request (summary, findings, suggestions)',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    prNumber: z.number().describe('Pull request number'),
    publish: z.boolean().optional().describe('Publish as PR comment (requires write token)')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    review: z.string(),
    model: z.string(),
    publishedUrl: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, prNumber, publish } = context;
    return await aiReviewPullRequest(repoUrl, prNumber, publish === true);
  },
});

// ============================================================================
// GITHUB ACTIONS
// ============================================================================

export const triggerWorkflowTool = createTool({
  id: 'trigger-workflow',
  description: 'Trigger a GitHub Actions workflow',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    workflowId: z.string().describe('Workflow file name or ID'),
    branch: z.string().optional().describe('Branch to run workflow on'),
    inputs: z.record(z.string()).optional().describe('Workflow inputs'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    workflowRunId: z.number().optional(),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, workflowId, branch, inputs } = context;
    return await triggerWorkflow(repoUrl, workflowId, branch, inputs);
  },
});

export const getWorkflowStatusTool = createTool({
  id: 'get-workflow-status',
  description: 'Get the status of GitHub Actions workflows',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    branch: z.string().optional().describe('Filter by branch'),
  }),
  outputSchema: z.object({
    workflows: z.array(z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().optional(),
      runNumber: z.number(),
      createdAt: z.string(),
      htmlUrl: z.string(),
    })),
    summary: z.string(),
  }),
  execute: async ({ context }) => {
    const { repoUrl, branch } = context;
    return await getWorkflowStatus(repoUrl, branch);
  },
});

// ============================================================================
// DOCUMENTATION
// ============================================================================


// ============================================================================
// IMPLEMENTATION FUNCTIONS
// ============================================================================

async function readFileFromRepo(repoUrl: string, filePath: string, branch?: string) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    throw new Error('GITHUB_TOKEN not set');
  }

  const branchesToTry: string[] = [];
  if (branch) {
    branchesToTry.push(branch);
  }

  try {
    const def = await getDefaultBranch(repoName, ghToken);
    if (def && !branchesToTry.includes(def)) {
      branchesToTry.push(def);
    }
  } catch {}

  if (!branchesToTry.length) {
    branchesToTry.push('main', 'master');
  }

  let lastError: Error | null = null;

  for (const tryBranch of branchesToTry) {
    try {
      const url = `https://api.github.com/repos/${repoName}/contents/${filePath}?ref=${tryBranch}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${ghToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      const payload = await parseJsonSafe<GitHubContentFile | GitHubDirectoryItem[] | GitHubContentError>(response);

      if (response.ok) {
        if (!payload) {
          throw new Error('Received empty response from GitHub');
        }

        if (Array.isArray(payload)) {
          throw new Error(`Path '${filePath}' is a directory, not a file`);
        }

        const { content, size, encoding } = payload;

        if (typeof content !== 'string' || typeof size !== 'number' || typeof encoding !== 'string') {
          throw new Error('Unexpected response format from GitHub');
        }

        return {
          content: Buffer.from(content, 'base64').toString('utf-8'),
          path: filePath,
          size,
          encoding,
        };
      }

      const maybeError = !Array.isArray(payload) ? payload : null;
      const errorMessage = maybeError?.message;
      const message = errorMessage ? `${response.statusText} - ${errorMessage}` : response.statusText;
      lastError = new Error(`Branch '${tryBranch}': ${message}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  try {
    const branchToExplain = branch || branchesToTry[0];
    const branchExists = await doesBranchExist(repoName, ghToken, branchToExplain);
    if (!branchExists) {
      throw new Error(`Failed to fetch file '${filePath}' from ${repoName}. Branch '${branchToExplain}' not found.`);
    }
  } catch {
    // ignore branch check errors
  }

  throw new Error(`Failed to fetch file '${filePath}' from ${repoName}. Last error: ${lastError?.message}. Path might not exist. Use list-repo-files to explore directories.`);
}

async function aiImprovePullRequest(repoUrl: string, prNumber: number, publish: boolean) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;

  const ghToken = process.env.GITHUB_TOKEN || '';
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini';
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set');

  const prMetaUrl = `https://api.github.com/repos/${repoName}/pulls/${prNumber}`;
  const prMetaResp = await fetch(prMetaUrl, {
    headers: {
      'Authorization': ghToken ? `Bearer ${ghToken}` : '',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const prMeta = await parseJsonSafe<GitHubPullRequest & GitHubContentError>(prMetaResp);
  if (!prMetaResp.ok || !prMeta) {
    const message = prMeta?.message ? `${prMetaResp.statusText} - ${prMeta.message}` : prMetaResp.statusText;
    throw new Error(`Failed to fetch PR metadata: ${message}`);
  }

  const diffUrl = prMeta.diff_url;
  if (!diffUrl) {
    throw new Error('PR diff URL is missing');
  }

  const diffResp = await fetch(diffUrl, {
    headers: {
      'Authorization': ghToken ? `Bearer ${ghToken}` : '',
      'Accept': 'application/vnd.github.v3.diff',
    },
  });
  if (!diffResp.ok) {
    throw new Error(`Failed to fetch PR diff: ${diffResp.statusText}`);
  }
  const diff = (await diffResp.text()).slice(0, 120000);

  const sys = 'You are an expert code reviewer. Return concise, actionable code suggestions with rationale and optional code snippets.';
  const user = [
    `Repository: ${repoName}`,
    `PR #${prNumber}: ${prMeta.title || ''}`,
    '',
    'Unified diff (clipped):',
    '```diff',
    diff,
    '```',
    '',
    'Output a concise markdown list of suggestions. For each item include:',
    '- File (and line if inferable)',
    '- What/Why',
    '- Severity (low|medium|high)',
    '- Suggested code snippet (when applicable)',
  ].join('\n');

  const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: openaiModel, temperature: 0.2, messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ] })
  });
  const openaiJson = await parseJsonSafe<OpenAIChatResponse>(openaiResp);
  if (!openaiResp.ok || !openaiJson) {
    const errorMessage = openaiJson?.error?.message;
    throw new Error(`OpenAI failed: ${openaiResp.statusText}${errorMessage ? ` - ${errorMessage}` : ''}`);
  }
  const suggestions = openaiJson.choices?.[0]?.message?.content || '';

  let publishedUrl: string | undefined;
  if (publish && ghToken && prMeta.comments_url) {
    const pubResp = await fetch(prMeta.comments_url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: suggestions }),
    });
    const pubJson = await parseJsonSafe<GitHubCommentResponse>(pubResp);
    if (pubResp.ok) {
      publishedUrl = pubJson?.html_url;
    }
  }

  return { success: true, suggestions, model: openaiModel, publishedUrl };
}

async function aiAskPullRequest(repoUrl: string, prNumber: number, question: string, publish: boolean) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;

  const ghToken = process.env.GITHUB_TOKEN || '';
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini';
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set');

  const prMetaUrl = `https://api.github.com/repos/${repoName}/pulls/${prNumber}`;
  const prMetaResp = await fetch(prMetaUrl, {
    headers: {
      'Authorization': ghToken ? `Bearer ${ghToken}` : '',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const prMeta = await parseJsonSafe<GitHubPullRequest & GitHubContentError>(prMetaResp);
  if (!prMetaResp.ok || !prMeta) {
    const message = prMeta?.message ? `${prMetaResp.statusText} - ${prMeta.message}` : prMetaResp.statusText;
    throw new Error(`Failed to fetch PR metadata: ${message}`);
  }

  const sys = 'You are an expert software engineer answering questions about a pull request precisely and concisely.';
  const user = [
    `Repository: ${repoName}`,
    `PR #${prNumber}: ${prMeta.title || ''}`,
    '',
    'PR description:',
    prMeta.body || '(empty)',
    '',
    `Question: ${question}`,
  ].join('\n');

  const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: openaiModel, temperature: 0.2, messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ] })
  });
  const openaiJson = await parseJsonSafe<OpenAIChatResponse>(openaiResp);
  if (!openaiResp.ok || !openaiJson) {
    const errorMessage = openaiJson?.error?.message;
    throw new Error(`OpenAI failed: ${openaiResp.statusText}${errorMessage ? ` - ${errorMessage}` : ''}`);
  }
  const answer = openaiJson.choices?.[0]?.message?.content || '';

  let publishedUrl: string | undefined;
  if (publish && ghToken && prMeta.comments_url) {
    const pubResp = await fetch(prMeta.comments_url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: answer }),
    });
    const pubJson = await parseJsonSafe<GitHubCommentResponse>(pubResp);
    if (pubResp.ok) {
      publishedUrl = pubJson?.html_url;
    }
  }
  return { success: true, answer, model: openaiModel, publishedUrl };
}

async function generateAndApplyLabels(repoUrl: string, prNumber: number, maxLabels: number) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN not set');
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini';
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set');

  const prMetaUrl = `https://api.github.com/repos/${repoName}/pulls/${prNumber}`;
  const prMetaResp = await fetch(prMetaUrl, {
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const prMeta = await parseJsonSafe<GitHubPullRequest & GitHubContentError>(prMetaResp);
  if (!prMetaResp.ok || !prMeta) {
    const message = prMeta?.message ? `${prMetaResp.statusText} - ${prMeta.message}` : prMetaResp.statusText;
    throw new Error(`Failed to fetch PR metadata: ${message}`);
  }
  const sys = 'You generate short, conventional repository labels for PRs. Output JSON {"labels": ["label1", ...]}. Prefer existing conventions: bug, enhancement, docs, tests, refactor, security, performance.';
  const user = [ `PR title: ${prMeta.title || ''}`, `PR description: ${prMeta.body || ''}`, `Limit to ${maxLabels} labels.` ].join('\n');
  const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: openaiModel, temperature: 0, response_format: { type: 'json_object' }, messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ] }) });
  const openaiJson = await parseJsonSafe<OpenAIChatResponse>(openaiResp);
  if (!openaiResp.ok || !openaiJson) {
    const errorMessage = openaiJson?.error?.message;
    throw new Error(`OpenAI failed: ${openaiResp.statusText}${errorMessage ? ` - ${errorMessage}` : ''}`);
  }
  const contentStr = openaiJson.choices?.[0]?.message?.content || '{}';
  const parsed = parseJsonStringSafe<OpenAIJsonLabelsResponse>(contentStr) || {};
  const labels = (parsed.labels || [])
    .slice(0, maxLabels)
    .map((label) => label.trim())
    .filter((label) => label.length > 0);

  const addLabelsUrl = `https://api.github.com/repos/${repoName}/issues/${prNumber}/labels`;
  const addResp = await fetch(addLabelsUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ labels }),
  });
  const addJson = await parseJsonSafe<GitHubContentError>(addResp);
  if (!addResp.ok) {
    const message = addJson?.message ? `${addResp.statusText} - ${addJson.message}` : addResp.statusText;
    throw new Error(`Failed to apply labels: ${message}`);
  }
  return { success: true, labels };
}

async function aiDraftChangelog(repoUrl: string, prNumber: number, publish: boolean) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;
  const ghToken = process.env.GITHUB_TOKEN || '';
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini';
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set');

  const prMetaUrl = `https://api.github.com/repos/${repoName}/pulls/${prNumber}`;
  const prMetaResp = await fetch(prMetaUrl, {
    headers: {
      'Authorization': ghToken ? `Bearer ${ghToken}` : '',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const prMeta = await parseJsonSafe<GitHubPullRequest & GitHubContentError>(prMetaResp);
  if (!prMetaResp.ok || !prMeta) {
    const message = prMeta?.message ? `${prMetaResp.statusText} - ${prMeta.message}` : prMetaResp.statusText;
    throw new Error(`Failed to fetch PR metadata: ${message}`);
  }
  const commitsUrl = `https://api.github.com/repos/${repoName}/pulls/${prNumber}/commits`;
  const commitsResp = await fetch(commitsUrl, {
    headers: {
      'Authorization': ghToken ? `Bearer ${ghToken}` : '',
      'Accept': 'application/vnd.github+json',
    },
  });
  const commitsJson = commitsResp.ok ? await parseJsonSafe<GitHubCommit[]>(commitsResp) : null;
  const commits = Array.isArray(commitsJson) ? commitsJson : [];
  const commitMsgs = commits
    .map((commit) => `- ${commit.commit?.message || ''}`)
    .join('\n')
    .slice(0, 4000);

  const sys = 'You draft semantic, clean CHANGELOG entries.';
  const user = [ `PR: ${prMeta.title || ''}`, '', 'Commit messages:', commitMsgs, '', 'Draft a CHANGELOG entry in markdown under sections (Added/Changed/Fixed/Removed). Keep concise.' ].join('\n');
  const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: openaiModel, temperature: 0.2, messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ] })
  });
  const openaiJson = await parseJsonSafe<OpenAIChatResponse>(openaiResp);
  if (!openaiResp.ok || !openaiJson) {
    const errorMessage = openaiJson?.error?.message;
    throw new Error(`OpenAI failed: ${openaiResp.statusText}${errorMessage ? ` - ${errorMessage}` : ''}`);
  }
  const changelog = openaiJson.choices?.[0]?.message?.content || '';

  let publishedUrl: string | undefined;
  if (publish && ghToken && prMeta.comments_url) {
    const pubResp = await fetch(prMeta.comments_url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: `Proposed CHANGELOG entry:\n\n${changelog}` }),
    });
    const pubJson = await parseJsonSafe<GitHubCommentResponse>(pubResp);
    if (pubResp.ok) {
      publishedUrl = pubJson?.html_url;
    }
  }
  return { success: true, changelog, model: openaiModel, publishedUrl };
}

async function getDefaultBranch(repoName: string, token: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${repoName}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.default_branch || null;
}

async function doesBranchExist(repoName: string, token: string, branch: string): Promise<boolean> {
  const url = `https://api.github.com/repos/${repoName}/branches/${encodeURIComponent(branch)}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  return resp.ok;
}

async function listFilesFromRepo(repoUrl: string, path: string, branch?: string) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN not set');

  // Determine default branch if not provided
  const targetBranch = branch || (await getDefaultBranch(repoName, ghToken)) || 'main';
  const url = `https://api.github.com/repos/${repoName}/contents/${path}?ref=${encodeURIComponent(targetBranch)}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const payload = await parseJsonSafe<GitHubDirectoryItem | GitHubDirectoryItem[] | GitHubContentError>(response);
  if (!response.ok || !payload) {
    const message = !Array.isArray(payload) && payload?.message ? `${response.statusText} - ${payload.message}` : response.statusText;
    throw new Error(`Failed to list path '${path || '/'}': ${message}`);
  }
  const arrayItems = Array.isArray(payload) ? payload : [payload];
  const items = arrayItems.map((item) => {
    const name = typeof item.name === 'string' ? item.name : '';
    const itemPath = typeof item.path === 'string' ? item.path : '';
    const type = item.type === 'dir' ? 'dir' : 'file';
    const size = typeof item.size === 'number' ? item.size : undefined;
    return { name, path: itemPath, type, size };
  });
  return { items };
}

async function findFileInRepo(repoUrl: string, query: string) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN not set');

  const fullQuery = `${query} repo:${repoName}`;
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(fullQuery)}&per_page=20`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const payload = await parseJsonSafe<GitHubCodeSearchResponse>(response);
  if (!response.ok || !payload) {
    const message = payload?.message ? `${response.statusText} - ${payload.message}` : response.statusText;
    throw new Error(`Search failed: ${message}`);
  }
  const items = Array.isArray(payload.items) ? payload.items : [];
  const results = items.map((item) => ({
    name: item?.name ?? '',
    path: item?.path ?? '',
    htmlUrl: item?.html_url ?? '',
  }));
  return { results };
}


async function createGitHubIssue(repoUrl: string, title: string, body: string, labels?: string[]) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN not set');

  try {
    const url = `https://api.github.com/repos/${repoName}/issues`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ title, body, labels: labels || [] }),
    });

    const payload = await parseJsonSafe<GitHubIssueResponse & GitHubContentError>(response);
    if (!response.ok || !payload) {
      const message = payload?.message ? `${response.statusText}. ${payload.message}` : response.statusText;
      throw new Error(`Failed to create issue: ${message}`);
    }

    return {
      issueNumber: payload.number ?? 0,
      issueUrl: payload.html_url ?? '',
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create issue on ${repoName}: ${errorMessage}`);
  }
}

async function commentOnGitHubIssue(repoUrl: string, issueNumber: number, comment: string) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN not set');

  try {
    const url = `https://api.github.com/repos/${repoName}/issues/${issueNumber}/comments`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ body: comment }),
    });

    const payload = await parseJsonSafe<GitHubCommentResponse & GitHubContentError>(response);
    if (!response.ok || !payload) {
      const message = payload?.message ? `${response.statusText}. ${payload.message}` : response.statusText;
      throw new Error(`Failed to comment: ${message}`);
    }

    return {
      success: true,
      commentUrl: payload.html_url ?? '',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to comment on issue #${issueNumber} in ${repoName}: ${errorMessage}`);
  }
}

async function closeGitHubIssue(repoUrl: string, issueNumber: number, comment?: string) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN not set');

  try {
    if (comment) {
      await commentOnGitHubIssue(repoUrl, issueNumber, comment);
    }

    const url = `https://api.github.com/repos/${repoName}/issues/${issueNumber}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ state: 'closed' }),
    });

    const payload = await parseJsonSafe<GitHubContentError>(response);
    if (!response.ok) {
      const message = payload?.message ? `${response.statusText}. ${payload.message}` : response.statusText;
      throw new Error(`Failed to close issue: ${message}`);
    }

    return {
      success: true,
      message: `Issue #${issueNumber} closed successfully`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to close issue #${issueNumber} in ${repoName}: ${errorMessage}`);
  }
}

async function checkDependencies(repoUrl: string) {
  let tmpDir: string | null = null;
  
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'reposage-deps-'));
    const git = simpleGit();
    await git.clone(repoUrl, tmpDir, ['--depth', '1']);

    // Run npm outdated
    try {
      const { stdout } = await execAsync('npm outdated --json', { cwd: tmpDir });
      const outdatedRecord = JSON.parse(stdout || '{}') as Record<string, NpmOutdatedEntry>;

      const { stdout: auditOutput } = await execAsync('npm audit --json', { cwd: tmpDir });
      const auditData = JSON.parse(auditOutput || '{}') as {
        vulnerabilities?: Record<string, NpmAuditVulnerability>;
      };

      const outdatedList = Object.entries(outdatedRecord).map(([name, info]) => ({
        name,
        current: info.current ?? 'unknown',
        latest: info.latest ?? 'unknown',
        type: info.type === 'devDependencies' ? 'devDependencies' as const : 'dependencies' as const,
      }));

      const vulnerabilities = Object.values(auditData.vulnerabilities || {}).map((vulnerability) => {
        const severityCandidate = vulnerability.severity?.toLowerCase() as ValidSeverity | undefined;
        const severity: ValidSeverity = severityCandidate && VALID_SEVERITIES.has(severityCandidate)
          ? severityCandidate
          : 'low';
        return {
          name: vulnerability.name ?? 'unknown',
          severity,
          description: vulnerability.title || 'No description',
        };
      });

      return {
        outdated: outdatedList,
        vulnerabilities,
        summary: `Found ${outdatedList.length} outdated packages and ${vulnerabilities.length} vulnerabilities`,
      };
    } catch {
      return {
        outdated: [],
        vulnerabilities: [],
        summary: 'No package.json found or unable to check dependencies',
      };
    }
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}


async function formatCode(repoUrl: string) {
  let tmpDir: string | null = null;
  
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'reposage-format-'));
    const git = simpleGit();
    await git.clone(repoUrl, tmpDir, ['--depth', '1']);

    // Run prettier
    try {
      await execAsync('npx prettier --write "**/*.{ts,tsx,js,jsx,json,md}"', { cwd: tmpDir });
      return {
        success: true,
        filesFormatted: 0,
        changes: ['Code formatted successfully'],
      };
    } catch {
      return {
        success: false,
        filesFormatted: 0,
        changes: ['Failed to format code'],
      };
    }
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}

async function fixLintErrors(repoUrl: string) {
  let tmpDir: string | null = null;
  
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'reposage-lint-fix-'));
    const git = simpleGit();
    await git.clone(repoUrl, tmpDir, ['--depth', '1']);

    try {
      await execAsync('npm run lint -- --fix || eslint . --fix', { cwd: tmpDir });
      return {
        success: true,
        errorsFixed: 0,
        remainingErrors: 0,
        message: 'Lint errors fixed successfully',
      };
    } catch {
      return {
        success: false,
        errorsFixed: 0,
        remainingErrors: 0,
        message: 'Failed to fix lint errors',
      };
    }
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}




async function mergePullRequest(repoUrl: string, prNumber: number, mergeMethod?: 'merge' | 'squash' | 'rebase') {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN not set');

  try {
    const url = `https://api.github.com/repos/${repoName}/pulls/${prNumber}/merge`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ merge_method: mergeMethod || 'merge' }),
    });

    const payload = await parseJsonSafe<GitHubMergeResponse>(response);

    if (!response.ok || !payload) {
      const message = payload?.message ? `${response.statusText}. ${payload.message}` : response.statusText;
      throw new Error(`Failed to merge PR: ${message}`);
    }

    return {
      success: true,
      merged: payload.merged ?? false,
      sha: payload.sha ?? '',
      message: payload.message || 'PR merged successfully',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to merge PR #${prNumber} in ${repoName}: ${errorMessage}`);
  }
}

async function triggerWorkflow(repoUrl: string, workflowId: string, branch?: string, inputs?: Record<string, string>) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN not set');

  try {
    const url = `https://api.github.com/repos/${repoName}/actions/workflows/${workflowId}/dispatches`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: branch || 'main', inputs: inputs || {} }),
    });

    const payload = await parseJsonSafe<GitHubWorkflowDispatchResponse>(response);

    if (!response.ok) {
      const message = payload?.message ? `${response.statusText}. ${payload.message}` : response.statusText;
      throw new Error(`Failed to trigger workflow: ${message}`);
    }

    return {
      success: true,
      message: 'Workflow triggered successfully',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to trigger workflow '${workflowId}' in ${repoName}: ${errorMessage}`);
  }
}

async function getWorkflowStatus(repoUrl: string, branch?: string) {
  const { owner, repo } = extractRepoIdentifiers(repoUrl);
  const repoName = `${owner}/${repo}`;

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN not set');

  try {
    let url = `https://api.github.com/repos/${repoName}/actions/runs?per_page=10`;
    if (branch) url += `&branch=${encodeURIComponent(branch)}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    const payload = await parseJsonSafe<GitHubWorkflowRunsResponse & GitHubContentError>(response);
    if (!response.ok || !payload) {
      const message = payload?.message ? `${response.statusText}. ${payload.message}` : response.statusText;
      throw new Error(`Failed to fetch workflows: ${message}`);
    }

    const workflowRuns = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
    const workflows = workflowRuns.map((run) => ({
      name: run.name ?? 'Unknown',
      status: run.status ?? 'unknown',
      conclusion: run.conclusion,
      runNumber: run.run_number ?? 0,
      createdAt: run.created_at ?? '',
      htmlUrl: run.html_url ?? '',
    }));

    const failed = workflows.filter((workflow) => workflow.conclusion === 'failure').length;
    const summary = workflows.length === 0
      ? 'No workflows found'
      : failed > 0
        ? `${failed} workflow(s) failed out of ${workflows.length}`
        : `All ${workflows.length} workflows passing`;

    return { workflows, summary };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get workflow status for ${repoName}: ${errorMessage}`);
  }
}


async function aiReviewPullRequest(repoUrl: string, prNumber: number, publish: boolean) {
  const repoMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!repoMatch) throw new Error('Invalid GitHub URL');
  const [, owner, repo] = repoMatch;
  const repoName = `${owner}/${repo.replace('.git', '')}`;

  const ghToken = process.env.GITHUB_TOKEN || '';
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini';
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set');

  const prMetaUrl = `https://api.github.com/repos/${repoName}/pulls/${prNumber}`;
  const prMetaResp = await fetch(prMetaUrl, {
    headers: {
      'Authorization': ghToken ? `Bearer ${ghToken}` : '',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!prMetaResp.ok) {
    const j = await parseJsonSafe<GitHubContentError>(prMetaResp);
    throw new Error(`Failed to fetch PR meta: ${prMetaResp.statusText}${j?.message ? ` - ${j.message}` : ''}`);
  }
  const prMeta = await prMetaResp.json();

  const commitsUrl = `https://api.github.com/repos/${repoName}/pulls/${prNumber}/commits`;
  const commitsResp = await fetch(commitsUrl, {
    headers: {
      'Authorization': ghToken ? `Bearer ${ghToken}` : '',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const commits = commitsResp.ok ? await commitsResp.json() : [];
  const commitMsgs = (commits || []).map((c: GitHubCommit) => `- ${c.commit?.message || ''}`).join('\n').slice(0, 4000);

  const diffUrl = prMeta.diff_url as string;
  const diffResp = await fetch(diffUrl, {
    headers: {
      'Authorization': ghToken ? `Bearer ${ghToken}` : '',
      'Accept': 'application/vnd.github.v3.diff',
    },
  });
  if (!diffResp.ok) {
    throw new Error(`Failed to fetch PR diff: ${diffResp.statusText}`);
  }
  const fullDiff = await diffResp.text();
  const diff = fullDiff.slice(0, 120000); // clip to ~120k chars to stay within token limits

  const sys = 'You are an expert senior code reviewer. Provide precise, actionable findings. Output concise markdown.';
  const user = [
    `Repository: ${repoName}`,
    `PR #${prNumber}: ${prMeta.title || ''}`,
    `Author: ${prMeta.user?.login || ''}`,
    '',
    'Commit messages:',
    commitMsgs,
    '',
    'Unified diff (clipped):',
    '```diff',
    diff,
    '```',
    '',
    'Please produce:',
    '- High-level summary',
    '- Key issues (file, line if possible, what, why, severity)',
    '- Security concerns, test coverage notes, and suggested improvements',
    '- Final concise checklist',
  ].join('\n');

  const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openaiModel,
      temperature: 0.2,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!openaiResp.ok) {
    const j = await parseJsonSafe<OpenAIChatResponse>(openaiResp);
    throw new Error(`OpenAI failed: ${openaiResp.statusText}${j?.error?.message ? ` - ${j.error.message}` : ''}`);
  }
  const openaiData = await openaiResp.json();
  const reviewText = openaiData?.choices?.[0]?.message?.content || '';

  let publishedUrl: string | undefined;
  if (publish && ghToken) {
    try {
      const commentsUrl = prMeta.comments_url as string;
      const pubResp = await fetch(commentsUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ghToken}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: reviewText }),
      });
      if (pubResp.ok) {
        const pub = await parseJsonSafe<GitHubCommentResponse>(pubResp);
        publishedUrl = pub?.html_url;
      }
    } catch {}
  }

  return {
    success: true,
    review: reviewText,
    model: openaiModel,
    publishedUrl,
  };
}

async function aiDescribePullRequest(repoUrl: string, prNumber: number, publish: boolean) {
  const repoMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!repoMatch) throw new Error('Invalid GitHub URL');
  const [, owner, repo] = repoMatch;
  const repoName = `${owner}/${repo.replace('.git', '')}`;

  const ghToken = process.env.GITHUB_TOKEN || '';
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini';
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set');

  const prMetaUrl = `https://api.github.com/repos/${repoName}/pulls/${prNumber}`;
  const prMetaResp = await fetch(prMetaUrl, {
    headers: {
      'Authorization': ghToken ? `Bearer ${ghToken}` : '',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!prMetaResp.ok) {
    const j = await parseJsonSafe<GitHubContentError>(prMetaResp);
    throw new Error(`Failed to fetch PR: ${prMetaResp.statusText}${j?.message ? ` - ${j.message}` : ''}`);
  }
  const prMeta = await prMetaResp.json();

  const filesUrl = `https://api.github.com/repos/${repoName}/pulls/${prNumber}/files?per_page=100`;
  const filesResp = await fetch(filesUrl, {
    headers: {
      'Authorization': ghToken ? `Bearer ${ghToken}` : '',
      'Accept': 'application/vnd.github+json',
    },
  });
  const files = filesResp.ok ? await filesResp.json() : [];
  const filesSummary = (files || []).slice(0, 100).map((f: { filename?: string; additions?: number; deletions?: number }) => `- ${f.filename || 'unknown'} (+${f.additions || 0}/-${f.deletions || 0})`).join('\n');

  const sys = 'You are an expert PR author. Improve titles and descriptions. Be concise and informative.';
  const user = [
    `Repository: ${repoName}`,
    `PR #${prNumber}`,
    `Current title: ${prMeta.title || ''}`,
    '',
    'Existing description:',
    prMeta.body || '(empty)',
    '',
    'Changed files summary:',
    filesSummary,
    '',
    'Produce JSON with keys {"title": string, "description": string} where description includes:',
    '- Summary',
    '- Changes made',
    '- Rationale',
    '- Impact/risks',
    '- Testing/validation notes',
    '- Breaking changes (if any)',
  ].join('\n');

  const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openaiModel,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!openaiResp.ok) {
    const j = await parseJsonSafe<OpenAIChatResponse>(openaiResp);
    throw new Error(`OpenAI failed: ${openaiResp.statusText}${j?.error?.message ? ` - ${j.error.message}` : ''}`);
  }
  const openaiData = await openaiResp.json();
  const contentStr = openaiData.choices[0].message.content || '{}';
  let parsed: { title?: string; description?: string } = {};
  try { parsed = JSON.parse(contentStr); } catch {}
  const title = (parsed.title || prMeta.title || '').slice(0, 256);
  const description = (parsed.description || '').slice(0, 40000);

  let published = false;
  if (publish && ghToken) {
    try {
      const patchResp = await fetch(prMetaUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${ghToken}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, body: description }),
      });
      if (patchResp.ok) published = true;
      else {
        // fallback: publish as comment
        const commentsUrl = prMeta.comments_url;
        if (commentsUrl) {
          await fetch(commentsUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${ghToken}`,
              'Accept': 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ body: `Suggested Title:\n${title}\n\nSuggested Description:\n\n${description}` }),
          });
        }
      }
    } catch {}
  }

  return { success: true, title, description, model: openaiModel, published };
}
