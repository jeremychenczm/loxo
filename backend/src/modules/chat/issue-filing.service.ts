import { type Issue } from '../../db/schema';
import { addHumanComment } from '../issues/comments.service';
import { createIssue } from '../issues/issues.service';
import { appendMessage, getConversation } from './conversations.service';

/**
 * Files a confirmed draft as an issue. The issue lands in the backlog — filing
 * captures work, moving it to todo dispatches it — assigned to the
 * conversation's agent by default since the chat context is theirs. Leaves a
 * breadcrumb on both sides: a timeline comment on the issue and a system
 * message in the chat. A conversation may file any number of issues.
 */
export async function fileIssueFromConversation(
  userId: string,
  conversationId: string,
  input: { title: string; description?: string; projectId?: string }
): Promise<Issue> {
  const conversation = await getConversation(userId, conversationId);

  const issue = await createIssue(userId, {
    title: input.title,
    description: input.description,
    projectId: input.projectId,
    assignee: { agentId: conversation.agentId },
    sourceConversationId: conversation.id,
  });

  // Breadcrumbs are best-effort: the issue is already committed, and a failed
  // annotation must not surface as a failed conversion.
  try {
    await addHumanComment(userId, issue.id, `Filed from the chat "${conversation.title}".`);
    await appendMessage(
      conversationId,
      'system',
      `Filed issue #${issue.issueNumber} from this conversation: ${issue.title}`,
      { source: 'issue_filing', issueId: issue.id }
    );
  } catch (error) {
    console.error(`Breadcrumbs for issue ${issue.id} failed:`, error);
  }

  return issue;
}
