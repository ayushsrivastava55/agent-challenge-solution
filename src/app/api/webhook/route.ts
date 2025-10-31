import { NextRequest, NextResponse } from 'next/server';
import { repoSageAgent } from '@/mastra/agents';

// GitHub Webhook endpoint for push events
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const event = request.headers.get('x-github-event');
    
    console.log(`Received GitHub event: ${event}`);

    // Handle push events
    if (event === 'push') {
      const { repository, ref, commits } = body;
      
      if (!repository || !commits || commits.length === 0) {
        return NextResponse.json({ message: 'No commits in push event' }, { status: 200 });
      }

      const repoUrl = repository.html_url;
      const branch = ref.replace('refs/heads/', '');
      const lastCommit = commits[commits.length - 1];

      console.log(`Processing push to ${repoUrl} on branch ${branch}`);
      console.log(`Latest commit: ${lastCommit.id} by ${lastCommit.author.name}`);

      // Trigger RepoSage agent to analyze the repository
      // Analyze the repository asynchronously
      // In production, this should be queued to a background job
      setTimeout(async () => {
        try {
          await repoSageAgent.generate([{
            role: 'user',
            content: `A new push was detected on ${repoUrl} (branch: ${branch}). 
            Commit: ${lastCommit.message} by ${lastCommit.author.name}.
            Please analyze this repository for issues and create a PR if fixes are needed.`
          }]);
        } catch (error) {
          console.error('Error analyzing repository:', error);
        }
      }, 100);

      return NextResponse.json({ 
        message: 'Webhook received, analysis queued',
        repository: repository.full_name,
        branch,
        commit: lastCommit.id.substring(0, 7)
      });
    }

    // Handle other events (optional)
    return NextResponse.json({ message: `Event ${event} received but not processed` }, { status: 200 });

  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

// Health check endpoint
export async function GET() {
  return NextResponse.json({ 
    status: 'ok', 
    service: 'RepoSage Webhook',
    timestamp: new Date().toISOString()
  });
}
