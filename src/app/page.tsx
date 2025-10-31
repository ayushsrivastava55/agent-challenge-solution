"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCoAgent, useCopilotAction } from "@copilotkit/react-core";
import { CopilotKitCSSProperties, CopilotSidebar } from "@copilotkit/react-ui";
import { useMemo, useState } from "react";
import { AgentState as AgentStateSchema } from "@/mastra/agents";
import { z } from "zod";
import { 
  RepoAnalysisResult, 
  PRCreationResult, 
  TestRunResult,
  // type
  CodeIssue,
} from "@/mastra/tools";

type AgentState = z.infer<typeof AgentStateSchema>;

export default function RepoSagePage() {
  const [themeColor, setThemeColor] = useState<string>("#0ea5e9");

  useCopilotAction({
    name: "setThemeColor",
    parameters: [{
      name: "themeColor",
      description: "The theme color to set.",
      required: true,
    }],
    handler({ themeColor }: { themeColor: string }) {
      setThemeColor(themeColor);
    },
  });

  return (
    <main style={{ "--copilot-kit-primary-color": themeColor } as CopilotKitCSSProperties}>
      <DashboardContent themeColor={themeColor} onPick={setThemeColor} />
      <StableSidebar />
    </main>
  );
}

function DashboardContent({ themeColor, onPick }: { themeColor: string; onPick: (c: string) => void }) {
  const { state } = useCoAgent<AgentState>({
    name: "repoSageAgent",
    initialState: {
      monitoredRepos: [],
      totalPRsCreated: 0,
      totalIssuesFixed: 0,
      activityLog: ["✓ RepoSage initialized and ready to monitor repositories"],
    },
  })

  // Generative UI for Repository Analysis
  useCopilotAction({
    name: "analyzeRepoTool",
    description: "Analyze a GitHub repository",
    available: "frontend",
    parameters: [
      { name: "repoUrl", type: "string", required: true },
      { name: "branch", type: "string", required: false },
    ],
    render: (props: any) => {
      const { args, result, status } = props;
      return <RepoAnalysisCard
        repoUrl={args?.repoUrl}
        themeColor={themeColor}
        result={result as RepoAnalysisResult}
        status={status as "inProgress" | "executing" | "complete"}
      />
    },
  });

  // Generative UI for PR Creation
  useCopilotAction({
    name: "createPRTool",
    description: "Create a Pull Request",
    available: "frontend",
    parameters: [
      { name: "repoUrl", type: "string", required: true },
      { name: "title", type: "string", required: true },
      { name: "description", type: "string", required: true },
      { name: "fixes", type: "string", required: true },
    ],
    render: (props: any) => {
      const { result, status } = props;
      return <PRCreationCard
        themeColor={themeColor}
        result={result as PRCreationResult}
        status={status as "inProgress" | "executing" | "complete"}
      />
    },
  });

  // Generative UI for Test Runs
  useCopilotAction({
    name: "runTestsTool",
    description: "Run repository tests",
    available: "frontend",
    parameters: [
      { name: "repoUrl", type: "string", required: true },
    ],
    render: (props: any) => {
      const { result, status } = props;
      return <TestRunCard
        themeColor={themeColor}
        result={result as TestRunResult}
        status={status as "inProgress" | "executing" | "complete"}
      />
    },
  });

  // Memory update visualization
  useCopilotAction({
    name: "updateWorkingMemory",
    available: "frontend",
    render: (_args) => {
      return (
        <div style={{ backgroundColor: themeColor }} className="rounded-2xl max-w-md w-full text-white p-4">
          <p>✨ Agent memory updated</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-white">View details</summary>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }} className="overflow-x-auto text-sm bg-white/20 p-4 rounded-lg mt-2">
              {JSON.stringify(_args, null, 2)}
            </pre>
          </details>
        </div>
      );
    },
  });

  return (
    <div
      style={{ background: `radial-gradient(1000px 600px at top right, ${themeColor}33, transparent), linear-gradient(180deg, ${themeColor}22, transparent)` }}
      className="min-h-screen w-screen flex justify-center items-start p-8 transition-colors duration-300"
    >
      <div className="max-w-6xl w-full space-y-6">
        {/* Header */}
        <div className="bg-white/10 backdrop-blur-xl p-8 rounded-2xl shadow-2xl ring-1 ring-white/20">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-4xl font-bold text-white mb-2 flex items-center gap-3">
                <GitHubIcon />
                RepoSage Dashboard
              </h1>
              <p className="text-white/80 text-lg">AI-Powered GitHub Auto-Fix Agent</p>
            </div>
            <ThemePicker themeColor={themeColor} onPick={onPick} />
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatsCard
            title="PRs Created"
            value={state.totalPRsCreated}
            icon="🚀"
          />
          <StatsCard
            title="Issues Fixed"
            value={state.totalIssuesFixed}
            icon="🔧"
          />
          <StatsCard
            title="Monitored Repos"
            value={state.monitoredRepos?.length || 0}
            icon="👁️"
          />
        </div>

        {/* Activity Log */}
        <div className="bg-white/10 backdrop-blur-xl p-6 rounded-2xl shadow-2xl ring-1 ring-white/20">
          <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
            📋 Activity Log
          </h2>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {state.activityLog?.slice(-10).reverse().map((log: string, index: number) => (
              <div
                key={index}
                className="bg-white/10 p-3 rounded-lg text-white/90 text-sm hover:bg-white/15 transition-all"
              >
                {log}
              </div>
            ))}
            {(!state.activityLog || state.activityLog.length === 0) && (
              <p className="text-white/60 italic text-center py-4">
                No activity yet. Start by analyzing a repository!
              </p>
            )}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ActionCard
            title="Analyze Repository"
            subtitle="Scan repo, get CI status"
            color={themeColor}
            hint="Analyze https://github.com/facebook/react"
          />
          <ActionCard
            title="Run Tests"
            subtitle="Trigger remote test run"
            color={themeColor}
            hint="Run tests for https://github.com/nosana-ci/nosana-cli"
          />
          <ActionCard
            title="Create PR"
            subtitle="Open a fix proposal"
            color={themeColor}
            hint="Create a PR to fix lint errors"
          />
        </div>

        {/* Monitored Repositories */}
        {state.monitoredRepos && state.monitoredRepos.length > 0 && (
          <div className="bg-white/10 backdrop-blur-xl p-6 rounded-2xl shadow-2xl ring-1 ring-white/20">
            <h2 className="text-2xl font-bold text-white mb-4">📦 Monitored Repositories</h2>
            <div className="space-y-3">
              {state.monitoredRepos.map((repo: { repoUrl: string; lastChecked: string; status: string }, index: number) => (
                <div
                  key={index}
                  className="bg-white/10 p-4 rounded-xl text-white hover:bg-white/15 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold">{repo.repoUrl}</p>
                      <p className="text-sm text-white/70">Last checked: {new Date(repo.lastChecked).toLocaleString()}</p>
                    </div>
                    <StatusBadge status={repo.status} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Components

function StatsCard({ title, value, icon }: { title: string; value: number; icon: string }) {
  return (
    <div className="bg-white/10 backdrop-blur-xl p-6 rounded-xl shadow-2xl ring-1 ring-white/20">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-white/70 text-sm mb-1">{title}</p>
          <p className="text-4xl font-bold text-white">{value}</p>
        </div>
        <div className="text-5xl">{icon}</div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    healthy: "bg-green-500",
    issues_detected: "bg-yellow-500",
    fixing: "bg-blue-500",
    pr_created: "bg-purple-500",
  };

  return (
    <span className={`${colors[status] || "bg-gray-500"} text-white text-xs px-3 py-1 rounded-full font-semibold`}>
      {status.replace(/_/g, " ").toUpperCase()}
    </span>
  );
}

function RepoAnalysisCard({
  repoUrl,
  themeColor,
  result,
  status
}: {
  repoUrl?: string,
  themeColor: string,
  result: RepoAnalysisResult,
  status: "inProgress" | "executing" | "complete"
}) {
  if (status !== "complete") {
    return (
      <div className="rounded-xl shadow-xl mt-4 mb-4 max-w-2xl w-full" style={{ backgroundColor: themeColor }}>
        <div className="bg-white/20 p-4 w-full">
          <p className="text-white animate-pulse">🔍 Analyzing repository: {repoUrl}...</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ backgroundColor: themeColor }} className="rounded-xl shadow-xl mt-4 mb-4 max-w-2xl w-full">
      <div className="bg-white/20 p-6 w-full">
        <h3 className="text-xl font-bold text-white mb-3">📊 Repository Analysis</h3>
        <div className="space-y-2 text-white">
          <p><strong>Repository:</strong> {result?.repoName}</p>
          <p><strong>Branch:</strong> {result?.branch}</p>
          <p><strong>Last Commit:</strong> {result?.lastCommit}</p>
          <p><strong>Tests Passing:</strong> {result?.testsPass ? "✅ Yes" : "❌ No"}</p>
          <p><strong>Issues Found:</strong> {result?.issues?.length || 0}</p>
        </div>
        {result?.issues && result.issues.length > 0 && (
          <div className="mt-4 pt-4 border-t border-white/30">
            <h4 className="font-bold text-white mb-2">Issues Detected:</h4>
            {result.issues.map((issue: CodeIssue, idx: number) => (
              <div key={idx} className="bg-white/10 p-3 rounded-lg mb-2 text-sm text-white">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs bg-red-500 px-2 py-1 rounded">{issue.type}</span>
                  <span className="text-xs bg-orange-500 px-2 py-1 rounded">{issue.severity}</span>
                </div>
                <p>{issue.message}</p>
                {issue.suggestion && <p className="text-xs text-white/70 mt-1">💡 {issue.suggestion}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PRCreationCard({
  themeColor,
  result,
  status
}: {
  themeColor: string,
  result: PRCreationResult,
  status: "inProgress" | "executing" | "complete"
}) {
  if (status !== "complete") {
    return (
      <div className="rounded-xl shadow-xl mt-4 mb-4 max-w-2xl w-full" style={{ backgroundColor: themeColor }}>
        <div className="bg-white/20 p-4 w-full">
          <p className="text-white animate-pulse">🚀 Creating Pull Request...</p>
        </div>
      </div>
    )
  }

  const success = result?.status === "created";

  return (
    <div style={{ backgroundColor: themeColor }} className="rounded-xl shadow-xl mt-4 mb-4 max-w-2xl w-full">
      <div className="bg-white/20 p-6 w-full">
        <h3 className="text-xl font-bold text-white mb-3">
          {success ? "✅ Pull Request Created!" : "❌ PR Creation Failed"}
        </h3>
        <div className="space-y-2 text-white">
          <p><strong>Title:</strong> {result?.title}</p>
          {success && (
            <>
              <p><strong>PR Number:</strong> #{result?.prNumber}</p>
              <p><strong>Branch:</strong> {result?.branchName}</p>
              <p><strong>URL:</strong> <a href={result?.prUrl} className="underline" target="_blank" rel="noopener noreferrer">{result?.prUrl}</a></p>
            </>
          )}
          <p className="text-sm text-white/80">{result?.message}</p>
        </div>
      </div>
    </div>
  );
}

function TestRunCard({
  themeColor,
  result,
  status
}: {
  themeColor: string,
  result: TestRunResult,
  status: "inProgress" | "executing" | "complete"
}) {
  if (status !== "complete") {
    return (
      <div className="rounded-xl shadow-xl mt-4 mb-4 max-w-2xl w-full" style={{ backgroundColor: themeColor }}>
        <div className="bg-white/20 p-4 w-full">
          <p className="text-white animate-pulse">🧪 Running test suite...</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ backgroundColor: themeColor }} className="rounded-xl shadow-xl mt-4 mb-4 max-w-2xl w-full">
      <div className="bg-white/20 p-6 w-full">
        <h3 className="text-xl font-bold text-white mb-3">
          {result?.passed ? "✅ Tests Passed" : "❌ Tests Failed"}
        </h3>
        <div className="space-y-2 text-white">
          <p><strong>Total Tests:</strong> {result?.totalTests}</p>
          <p><strong>Failed:</strong> {result?.failedTests}</p>
          <p><strong>Duration:</strong> {result?.duration}ms</p>
        </div>
        {result?.errors && result.errors.length > 0 && (
          <div className="mt-4 pt-4 border-t border-white/30">
            <h4 className="font-bold text-white mb-2">Errors:</h4>
            {result.errors.map((error: string, idx: number) => (
              <div key={idx} className="bg-red-500/20 p-2 rounded text-sm text-white mb-2 font-mono">
                {error}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg className="w-10 h-10 text-white" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
    </svg>
  );
}

function StableSidebar() {
  const labels = useMemo(() => ({
    title: "RepoSage AI Assistant",
    initial:
      "👋 Hi! I'm **RepoSage**, your AI-powered GitHub auto-fix agent.\n\n**What I can do:**\n\n🔍 **Analyze Repositories**\n- \"Analyze https://github.com/facebook/react\"\n- \"Check for issues in repo-url\"\n\n🧪 **Run Tests**\n- \"Run tests for https://github.com/user/repo\"\n- \"Check test status\"\n\n🔧 **Fix Issues**\n- \"Fix the failing tests\"\n- \"Create a PR to fix lint errors\"\n\n📊 **Code Quality**\n- \"Analyze code quality\"\n- \"Search for similar issues\"\n\n💡 **Try**: \"Analyze https://github.com/nosana-ci/nosana-cli\"\n\nI'll monitor repos, detect issues, and create PRs with fixes!",
  }), []);

  return (
    <CopilotSidebar
      clickOutsideToClose={false}
      defaultOpen={true}
      labels={labels}
    />
  );
}

function ThemePicker({ themeColor, onPick }: { themeColor: string; onPick: (c: string) => void }) {
  const palette = ["#0ea5e9", "#10b981", "#8b5cf6", "#f59e0b", "#ef4444"];
  return (
    <div className="flex items-center gap-3">
      <div className="text-right">
        <div className="text-white/60 text-sm">Powered by Nosana</div>
        <div className="text-white/60 text-sm">Built with Mastra</div>
      </div>
      <div className="flex items-center gap-2">
        {palette.map((c) => (
          <button
            key={c}
            aria-label={`Set theme ${c}`}
            className={`h-6 w-6 rounded-full ring-2 ${themeColor === c ? 'ring-white' : 'ring-white/30'} transition-transform hover:scale-110`}
            style={{ backgroundColor: c }}
            onClick={() => onPick(c)}
          />
        ))}
      </div>
    </div>
  );
}

function ActionCard({ title, subtitle, color, hint }: { title: string; subtitle: string; color: string; hint: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hint);
    } catch {}
  };
  return (
    <div className="bg-white/10 backdrop-blur-xl p-6 rounded-xl shadow-2xl ring-1 ring-white/20 text-white">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-lg font-semibold">{title}</div>
          <div className="text-white/70 text-sm">{subtitle}</div>
        </div>
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      </div>
      <div className="mt-3 text-xs text-white/70 font-mono break-all">{hint}</div>
      <div className="mt-4">
        <button onClick={copy} className="px-3 py-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-sm">Copy Prompt</button>
      </div>
    </div>
  );
}
