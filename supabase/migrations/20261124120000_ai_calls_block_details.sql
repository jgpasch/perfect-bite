-- Why a provider blocked a call (spec 5, 6.4). finish_reason is the AI SDK's unified reason, so
-- every safety block reads `content-filter`; raw_finish_reason is the provider's own (Gemini's
-- RECITATION, SAFETY, PROHIBITED_CONTENT, an Anthropic `refusal`), on every runAiTask row.
-- provider_metadata is kept on failed rows only, and only the parts that say why: per provider,
-- safetyRatings, promptFeedback and finishMessage, when any is set. Both are null on older rows
-- and on the image call's rows.

alter table public.ai_calls
  add column raw_finish_reason text,
  add column provider_metadata jsonb;
