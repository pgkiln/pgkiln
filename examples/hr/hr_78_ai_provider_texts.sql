-- =====================================================================
-- HR example, part 78: AI provider texts (sprint 145, AP-11)
--
-- Parts 41 and 42 told the user an administrator adds an AI service
-- HR_ASSISTANT "(Claude or OpenAI ...)". AI services can also be Gemini or
-- any OpenAI-compatible endpoint (Ollama, vLLM, Azure OpenAI, a gateway).
-- A fresh install gets the new text from parts 41 and 42; this part
-- updates the pages of an installation that applied them earlier.
-- =====================================================================

update meta.region r
   set source = replace(source, 'Claude or OpenAI', 'Claude, OpenAI, Gemini or an OpenAI-compatible service')
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no in (37, 38)
   and r.source like '%Claude or OpenAI%';
