import { type Task } from '../../db/schema';
import { addHumanComment } from '../tasks/comments.service';
import { createTask } from '../tasks/tasks.service';
import { appendMessage, getConversation } from './conversations.service';

/**
 * Files a confirmed draft as a task. The task lands in the backlog — filing
 * captures work, moving it to todo dispatches it — assigned to the
 * conversation's agent by default since the chat context is theirs. Leaves a
 * breadcrumb on both sides: a timeline comment on the task and a system
 * message in the chat. A conversation may file any number of tasks.
 */
export async function fileTaskFromConversation(
  userId: string,
  conversationId: string,
  input: { title: string; brief?: string; repositoryId?: string }
): Promise<Task> {
  const conversation = await getConversation(userId, conversationId);

  const task = await createTask(userId, {
    title: input.title,
    brief: input.brief,
    repositoryId: input.repositoryId,
    assignee: { agentId: conversation.agentId },
    sourceConversationId: conversation.id,
  });

  // Breadcrumbs are best-effort: the task is already committed, and a failed
  // annotation must not surface as a failed conversion.
  try {
    await addHumanComment(userId, task.id, `Filed from the chat "${conversation.title}".`);
    await appendMessage(
      conversationId,
      'system',
      `Filed task #${task.number} from this conversation: ${task.title}`,
      { source: 'task_filing', taskId: task.id }
    );
  } catch (error) {
    console.error(`Breadcrumbs for task ${task.id} failed:`, error);
  }

  return task;
}
