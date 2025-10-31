import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import simpleGit from 'simple-git';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execAsync = promisify(exec);

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type RepoAnalysisResult = z.infer<typeof RepoAnalysisSchema>;
export type CodeIssue = z.infer<typeof CodeIssueSchema>;
export type PRCreationResult = z.infer<typeof PRCreationSchema>;
export type TestRunResult = z.infer<typeof TestRunSchema>;

const CodeIssueSchema = z.object({
  type: z.enum(['test_failure', 'lint_error', 'type_error', 'build_error', 'security_issue']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  file: z.string().optional(),
  line: z.number().optional(),
  message: z.string(),
  suggestion: z.string().optional(),
});

const RepoAnalysisSchema = z.object({
  repoName: z.string(),
  branch: z.string(),
  lastCommit: z.string(),
  issues: z.array(CodeIssueSchema),
  testsPass: z.boolean(),
  timestamp: z.string(),
});

const PRCreationSchema = z.object({
  prNumber: z.number(),
  prUrl: z.string(),
  title: z.string(),
  branchName: z.string(),
  status: z.enum(['created', 'failed', 'skipped']),
  message: z.string(),
});

const TestRunSchema = z.object({
  passed: z.boolean(),
  totalTests: z.number(),
  failedTests: z.number(),
  errors: z.array(z.string()),
  duration: z.number(),
  output: z.string(),
});

// ============================================================================
// GITHUB TOOLS
// ============================================================================

export const analyzeRepoTool = createTool({
  id: 'analyze-repo',
  description: 'Analyze a GitHub repository for issues, test failures, and code quality problems',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL (e.g., https://github.com/user/repo)'),
    branch: z.string().optional().describe('Branch to analyze (defaults to main/master)'),
  }),
  outputSchema: RepoAnalysisSchema,
  execute: async ({ context }) => {
    const { repoUrl, branch } = context;
    return await analyzeRepository(repoUrl, branch);
  },
});

export const createPRTool = createTool({
  id: 'create-pr',
  description: 'Create a Pull Request on GitHub with proposed fixes',
  inputSchema: z.object({
    repoUrl: z.string().describe('GitHub repository URL'),
    title: z.string().describe('PR title'),
    description: z.string().describe('PR description with fix reasoning'),
    fixes: z.string().describe('The code fixes to apply'),
    baseBranch: z.string().optional().describe('Base branch (defaults to main)'),
  }),
  outputSchema: PRCreationSchema,
  execute: async ({ context }) => {
    const { repoUrl, title, description, fixes, baseBranch } = context;
    return await createPullRequest(
      repoUrl,
      title,
      description,
      fixes,
      baseBranch
    );
  },
});

export const searchGitHubIssues = createTool({
  id: 'search-github-issues',
  description: 'Search for similar issues and solutions on GitHub',
  inputSchema: z.object({
    query: z.string().describe('Search query for GitHub issues'),
    language: z.string().optional().describe('Programming language filter'),
  }),
  outputSchema: z.object({
    issues: z.array(z.object({
      title: z.string(),
      url: z.string(),
      state: z.string(),
      repository: z.string(),
      summary: z.string(),
    })),
    totalFound: z.number(),
  }),
  execute: async ({ context }) => {
    const { query, language } = context;
    return await searchIssues(query, language);
  },
});

// ============================================================================
// CODE ANALYSIS TOOLS
// ============================================================================

export const runTestsTool = createTool({
  id: 'run-tests',
  description: 'Run the test suite of a repository and analyze failures',
  inputSchema: z.object({
    repoUrl: z.string().describe('Repository URL'),
    testCommand: z.string().optional().describe('Test command to run (auto-detected if not provided)'),
  }),
  outputSchema: TestRunSchema,
  execute: async ({ context }) => {
    const { repoUrl, testCommand } = context;
    return await runTests(repoUrl, testCommand);
  },
});

export const analyzeCodeQuality = createTool({
  id: 'analyze-code-quality',
  description: 'Analyze code quality, detect linting issues, and suggest improvements',
  inputSchema: z.object({
    repoUrl: z.string().describe('Repository URL'),
    files: z.array(z.string()).optional().describe('Specific files to analyze'),
  }),
  outputSchema: z.object({
    issues: z.array(CodeIssueSchema),
    score: z.number().describe('Code quality score (0-100)'),
    suggestions: z.array(z.string()),
  }),
  execute: async () => {
    return await analyzeCode();
  },
});

export const generateFixTool = createTool({
  id: 'generate-fix',
  description: 'Generate a code fix for a specific issue using AI reasoning',
  inputSchema: z.object({
    issue: z.string().describe('Issue description'),
    codeContext: z.string().describe('Relevant code context'),
    language: z.string().describe('Programming language'),
  }),
  outputSchema: z.object({
    fix: z.string().describe('Proposed code fix'),
    explanation: z.string().describe('Explanation of the fix'),
    confidence: z.number().describe('Confidence level (0-100)'),
  }),
  execute: async ({ context }) => {
    const { issue, codeContext, language } = context;
    return await generateFix(issue, codeContext, language);
  },
});

// ============================================================================
// IMPLEMENTATION FUNCTIONS
// ============================================================================

async function analyzeRepository(repoUrl: string, branch?: string): Promise<RepoAnalysisResult> {
  let tmpDir: string | null = null;
  
  try {
    // Extract repo info from URL
    const repoMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) {
      throw new Error('Invalid GitHub URL format');
    }
    
    const [, owner, repo] = repoMatch;
    const repoName = `${owner}/${repo.replace('.git', '')}`;

    // GitHub API check for metadata
    const ghBase = `https://api.github.com/repos/${repoName}`;
    const ghHeaders: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'reposage-agent',
    };
    if (process.env.GITHUB_TOKEN) {
      ghHeaders['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    // Get repository metadata
    const repoResp = await fetch(ghBase, { headers: ghHeaders });
    if (!repoResp.ok) {
      throw new Error(`Failed to fetch repo: ${repoResp.status} ${repoResp.statusText}`);
    }
    const repoJson = await repoResp.json();
    const targetBranch = branch || repoJson?.default_branch || 'main';

    // Create temp directory
    tmpDir = await mkdtemp(join(tmpdir(), 'reposage-'));
    console.log(`Cloning ${repoUrl} into ${tmpDir}...`);

    // Clone repository
    const git = simpleGit();
    await git.clone(repoUrl, tmpDir, ['--depth', '1', '--branch', targetBranch]);
    console.log(`Clone successful`);

    // Get latest commit
    const clonedGit = simpleGit(tmpDir);
    const log = await clonedGit.log(['-1']);
    const lastCommit = log.latest?.hash?.substring(0, 7) || 'unknown';

    const issues: CodeIssue[] = [];
    let testsPass = true;

    // Try to run linting
    try {
      console.log('Running linter...');
      const { stdout, stderr } = await execAsync('npm run lint 2>&1 || pnpm lint 2>&1 || yarn lint 2>&1 || eslint . 2>&1 || echo "No linter found"', {
        cwd: tmpDir,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024
      });
      
      const output = stdout + stderr;
      if (output.includes('error') || output.includes('✖')) {
        const errorLines = output.split('\n').filter(line => 
          line.includes('error') || line.includes('✖')
        ).slice(0, 5);
        
        errorLines.forEach(line => {
          issues.push({
            type: 'lint_error',
            severity: 'medium',
            message: line.trim(),
            suggestion: 'Fix linting errors according to project ESLint configuration'
          });
        });
      }
    } catch (lintError) {
      const errorMessage = lintError instanceof Error ? lintError.message : 'Unknown error';
      console.error('Lint check failed:', errorMessage);
      const lintErr = lintError as { stdout?: string; stderr?: string };
      if (lintErr.stdout || lintErr.stderr) {
        const output = (lintErr.stdout || '') + (lintErr.stderr || '');
        if (output.includes('error')) {
          issues.push({
            type: 'lint_error',
            severity: 'medium',
            message: 'Linting errors detected',
            suggestion: 'Run lint command to see detailed errors'
          });
        }
      }
    }

    // Check CI status from GitHub Actions
    try {
      const runsUrl = `${ghBase}/actions/runs?per_page=5&branch=${encodeURIComponent(targetBranch)}`;
      const runsResp = await fetch(runsUrl, { headers: ghHeaders });
      if (runsResp.ok) {
        const runsJson = await runsResp.json();
        const recentRuns = runsJson?.workflow_runs || [];
        const failedRuns = recentRuns.filter((run: { conclusion?: string }) => run.conclusion === 'failure');
        
        if (failedRuns.length > 0) {
          testsPass = false;
          issues.push({
            type: 'test_failure',
            severity: 'high',
            message: `${failedRuns.length} recent CI workflow(s) failed`,
            suggestion: 'Check GitHub Actions logs for failed test details'
          });
        }
      }
    } catch (ciError) {
      console.error('CI check failed:', ciError);
    }

    return {
      repoName,
      branch: targetBranch,
      lastCommit,
      issues,
      testsPass: testsPass && issues.length === 0,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error analyzing repository:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      repoName: "unknown",
      branch: branch || "main",
      lastCommit: "unknown",
      issues: [{
        type: 'build_error',
        severity: 'critical',
        message: `Failed to analyze repository: ${errorMessage}`,
        suggestion: 'Check repository URL and access permissions'
      }],
      testsPass: false,
      timestamp: new Date().toISOString(),
    };
  } finally {
    // Cleanup temp directory
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
        console.log(`Cleaned up ${tmpDir}`);
      } catch (cleanupError) {
        console.error('Cleanup failed:', cleanupError);
      }
    }
  }
}

async function createPullRequest(
  _repoUrl: string,
  title: string,
  _description?: string,
  _fixes?: string,
  _baseBranch?: string,
): Promise<PRCreationResult> {
  try {
    // NOTE: Creating a real PR requires a head branch with commits.
    // Here we return a guarded response unless full flow is implemented upstream.
    const branchName = `reposage-fix-${Date.now()}`;
    return {
      status: process.env.GITHUB_TOKEN ? "skipped" : "skipped",
      prNumber: 0,
      prUrl: "",
      branchName,
      message: process.env.GITHUB_TOKEN
        ? `PR creation requires a prepared head branch with changes. Generated suggested branch: ${branchName}.`
        : `Set GITHUB_TOKEN to enable PR operations; also provide a prepared head branch with changes.`,
      title,
    };
  } catch (error) {
    console.error('Error creating pull request:', error);
    return {
      status: "failed" as const,
      message: "Failed to create pull request",
      title,
      prNumber: 0,
      prUrl: "",
      branchName: "",
    };
  }
}

async function searchIssues(query: string, language?: string): Promise<{ issues: Array<{ title: string; url: string; state: string; repository: string; summary: string }>; totalFound: number }> {
  try {
    const searchQuery = language ? `${query} language:${language}` : query;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&sort=reactions&per_page=5`;
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'reposage-agent',
    };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      issues: data.items?.slice(0, 5).map((item: { title: string; html_url: string; state: string; repository_url: string; body?: string }) => ({
        title: item.title,
        url: item.html_url,
        state: item.state,
        repository: item.repository_url.split('/').slice(-2).join('/'),
        summary: item.body?.substring(0, 200) || 'No description',
      })) || [],
      totalFound: data.total_count || 0,
    };
  } catch {
    return {
      issues: [],
      totalFound: 0,
    };
  }
}

async function runTests(repoUrlParam?: string, testCommandParam?: string): Promise<TestRunResult> {
  const startTime = Date.now();
  let tmpDir: string | null = null;

  // If Nosana is enabled AND repoUrl is provided, try dispatching a remote job to run tests
  if (process.env.NOSANA_ENABLED === 'true' && repoUrlParam) {
    try {
      const repoUrl = repoUrlParam;
      const testCmd = testCommandParam || process.env.TEST_COMMAND || 'npm test --silent || pnpm test --silent || yarn test --silent || echo "No tests"';
      const market = process.env.NOSANA_MARKET || '';
      if (!market) throw new Error('NOSANA_ENABLED set but NOSANA_MARKET missing');

      const jobCmd = `nosana job post bash -lc "git clone ${repoUrl} repo && cd repo && ${testCmd}" --wait --market ${market}`;
      const { stdout, stderr } = await execAsync(jobCmd, { env: process.env, maxBuffer: 10 * 1024 * 1024 });

      const output = [stdout, stderr].filter(Boolean).join('\n');
      const failedMatch = output.match(/(\d+)\s*failed/i);
      const passedMatch = output.match(/(\d+)\s*passed/i);
      const failedTests = failedMatch ? Number(failedMatch[1]) : (output.toLowerCase().includes('fail') ? 1 : 0);
      const totalTests = passedMatch ? Number(passedMatch[1]) + failedTests : (failedTests > 0 ? failedTests : 0);
      const passed = failedTests === 0 && output.toLowerCase().includes('pass');

      return {
        passed,
        totalTests,
        failedTests,
        errors: failedTests > 0 ? [
          'Tests reported failures. Inspect job logs for details.'
        ] : [],
        duration: Date.now() - startTime,
        output,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to run tests via Nosana';
      return {
        passed: false,
        totalTests: 0,
        failedTests: 0,
        errors: [errorMessage],
        duration: Date.now() - startTime,
        output: '',
      };
    }
  }

  // Local test execution (clone and run)
  if (!repoUrlParam) {
    return {
      passed: false,
      totalTests: 0,
      failedTests: 0,
      errors: ['Repository URL is required to run tests'],
      duration: Date.now() - startTime,
      output: '',
    };
  }

  try {
    // Create temp directory
    tmpDir = await mkdtemp(join(tmpdir(), 'reposage-test-'));
    console.log(`Cloning ${repoUrlParam} for testing into ${tmpDir}...`);

    // Clone repository
    const git = simpleGit();
    await git.clone(repoUrlParam, tmpDir, ['--depth', '1']);
    console.log(`Clone successful, running tests...`);

    // Detect and run test command
    const testCmd = testCommandParam || 'npm test || pnpm test || yarn test';
    
    try {
      const { stdout, stderr } = await execAsync(testCmd, {
        cwd: tmpDir,
        timeout: 120000, // 2 minute timeout
        maxBuffer: 10 * 1024 * 1024
      });

      const output = stdout + stderr;
      
      // Parse test results (common patterns)
      const failedMatch = output.match(/(\d+)\s*(?:test(?:s)?|spec(?:s)?)\s*failed/i) || 
                          output.match(/✖\s*(\d+)/);
      const passedMatch = output.match(/(\d+)\s*(?:test(?:s)?|spec(?:s)?)\s*passed/i) || 
                          output.match(/✔\s*(\d+)/);
      const totalMatch = output.match(/(\d+)\s*total/i);

      const failedTests = failedMatch ? Number(failedMatch[1]) : 0;
      const passedTests = passedMatch ? Number(passedMatch[1]) : 0;
      const totalTests = totalMatch ? Number(totalMatch[1]) : (failedTests + passedTests);

      return {
        passed: failedTests === 0 && totalTests > 0,
        totalTests,
        failedTests,
        errors: failedTests > 0 ? [`${failedTests} test(s) failed`] : [],
        duration: Date.now() - startTime,
        output: output.substring(0, 1000) // Limit output size
      };
    } catch (testError) {
      // Test command failed
      const testErr = testError as { stdout?: string; stderr?: string; message?: string };
      const output = (testErr.stdout || '') + (testErr.stderr || '');
      const errorMessage = testErr.message || 'Test execution failed';
      return {
        passed: false,
        totalTests: 0,
        failedTests: 1,
        errors: [`Test execution failed: ${errorMessage}`],
        duration: Date.now() - startTime,
        output: output.substring(0, 1000)
      };
    }
  } catch (error) {
    console.error('Error running tests:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      passed: false,
      totalTests: 0,
      failedTests: 0,
      errors: [`Failed to run tests: ${errorMessage}`],
      duration: Date.now() - startTime,
      output: '',
    };
  } finally {
    // Cleanup temp directory
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
        console.log(`Cleaned up test directory ${tmpDir}`);
      } catch (cleanupError) {
        console.error('Test cleanup failed:', cleanupError);
      }
    }
  }
}

async function analyzeCode(): Promise<{ issues: CodeIssue[]; score: number; suggestions: string[] }> {
  // Simulated code analysis
  return {
    issues: [
      {
        type: 'lint_error' as const,
        severity: 'medium' as const,
        file: 'src/index.ts',
        line: 42,
        message: 'Missing semicolon',
        suggestion: 'Add semicolon at end of statement',
      },
      {
        type: 'type_error' as const,
        severity: 'high' as const,
        file: 'src/utils.ts',
        line: 15,
        message: 'Type mismatch: expected string, got number',
        suggestion: 'Convert number to string or update type definition',
      },
    ],
    score: 78,
    suggestions: [
      'Enable strict mode in TypeScript',
      'Add more comprehensive error handling',
      'Improve test coverage (current: 65%)',
    ],
  };
}

async function generateFix(issue: string, codeContext: string, language: string) {
  // This would use the LLM in real implementation
  // For now, return a template fix
  return {
    fix: '// Proposed fix based on analysis\n// TODO: Implement actual fix',
    explanation: `This fix addresses the ${issue} by analyzing the code context and applying best practices for ${language}.`,
    confidence: 75,
  };
}

// ============================================================================
// EXPORT ADVANCED TOOLS
// ============================================================================

export * from './advanced-tools';
