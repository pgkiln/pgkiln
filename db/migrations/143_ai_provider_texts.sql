-- Sprint 145 (AP-11): the description of meta.ai_service still named only Claude and OpenAI; AI services have also
-- been Gemini and any OpenAI-compatible endpoint (Ollama, vLLM, Azure OpenAI, a gateway) since 0.52.0.
comment on table meta.ai_service is 'AI services (Claude, OpenAI, Gemini or an OpenAI-compatible endpoint) of this installation; the API key is encrypted and never readable by applications';
