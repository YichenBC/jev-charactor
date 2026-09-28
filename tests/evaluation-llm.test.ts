import {it,expect,vi} from 'vitest';
import {llmProvider} from '../scripts/evaluation/llm';
import {developmentCases} from '../scripts/evaluation/cases';
it('LLM baseline selects the same contract and retains provider metadata',async()=>{
  vi.stubEnv('OPENROUTER_API_KEY','test');vi.stubEnv('EVAL_LLM_MODEL','test/model');
  try{
    const input=developmentCases()[0].input;
    const fake=(async(url:unknown,init?:RequestInit)=>{
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');const body=JSON.parse(String(init?.body));
      expect(body.model).toBe('test/model');expect(body.messages[1].content).toContain(JSON.stringify(input.state));
      expect(body.messages[1].content).not.toContain('acceptableChoices');expect(body.response_format.type).toBe('json_schema');
      return Response.json({model:'test/returned',choices:[{finish_reason:'stop',message:{content:JSON.stringify({action:input.options[0].id,reaction:'focused'})}}],usage:{cost:.002}});
    }) as typeof fetch;
    expect(await llmProvider(fake).decide(input)).toMatchObject({choice:input.options[0].id,affect:'focused',cost:.002,model:'test/returned',contractValid:true});
  }finally{vi.unstubAllEnvs();}
});
it('keeps invalid generated content out of game execution without losing billing',async()=>{
  vi.stubEnv('OPENROUTER_API_KEY','test');vi.stubEnv('EVAL_LLM_MODEL','test/model');
  try{
    const result=await llmProvider((async()=>Response.json({choices:[{finish_reason:'stop',message:{content:'invalid-json'}}],usage:{cost:.001}})) as typeof fetch).decide(developmentCases()[0].input);
    expect(result.contractValid).toBe(false);expect(result.cost).toBe(.001);expect(result.model).toBeUndefined();
  }finally{vi.unstubAllEnvs();}
});
