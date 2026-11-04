// The system prompt: the common part, then the profile's role.
import type {Profile} from '../store/types.ts';

export const BASE_PROMPT = 'Ты — помощник в боковой панели браузера пользователя. '
  + 'Отвечай ясно и коротко, используй Markdown, где он помогает. Отвечай на языке сообщения пользователя.';

export function systemPrompt(profile: Profile): string {
  const role = profile.prompt.trim();
  return role ? `${BASE_PROMPT}\n\n## Роль\n\n${role}` : BASE_PROMPT;
}
