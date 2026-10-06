import { describe, expect, it } from 'vitest';
import { codexOutputText, summarizeCodexExec } from '../session/codexExecSummary.js';

describe('summarizeCodexExec', () => {
  it('surfaces the shell command of an exec_command call', () => {
    const input = 'const r=await tools.exec_command({cmd:"git status --short && rg -n \\"BACKEND\\" .","workdir":"/repo"});text(r.output);\n';
    expect(summarizeCodexExec(input)).toEqual({ toolName: 'Bash', content: 'git status --short && rg -n "BACKEND" .' });
  });

  it('lists every inner call of a Promise.allSettled batch', () => {
    const input = 'const r = await Promise.allSettled([\n  tools.web__run({open:[{ref_id:"https://x.test/a"}]}),\n  tools.exec_command({cmd:"ls"})\n]);';
    expect(summarizeCodexExec(input)).toEqual({ toolName: 'WebSearch, Bash', content: 'https://x.test/a · ls' });
  });

  it('shows the patched file for apply_patch', () => {
    const input = 'await tools.apply_patch("*** Begin Patch\\n*** Update File: studio/a.py\\n@@\\n-x\\n+y\\n*** End Patch");';
    expect(summarizeCodexExec(input)).toEqual({ toolName: 'Edit', content: 'studio/a.py' });
  });

  it('falls back to the first code line when no tool is called', () => {
    expect(summarizeCodexExec('\ntext(ALL_TOOLS.length);\n')).toEqual({ toolName: 'exec', content: 'text(ALL_TOOLS.length);' });
  });
});

describe('codexOutputText', () => {
  it('strips the script header and reads wall time', () => {
    const out = [{ type: 'input_text', text: 'Script completed\nWall time 1.8 seconds\nOutput:\n' }, { type: 'input_text', text: 'hello' }];
    expect(codexOutputText(out)).toEqual({ text: 'hello', wallMs: 1800, isError: false });
  });

  it('flags failed scripts', () => {
    expect(codexOutputText([{ type: 'input_text', text: 'Script error:\nTypeError: boom' }]).isError).toBe(true);
  });
});

describe('summarizeCodexExec edge inputs', () => {
  it('finds patch files bound to a variable before the call', () => {
    const input = 'const patch="*** Begin Patch\\n*** Update File: tests/x.py\\n@@\\n*** End Patch";\nawait tools.apply_patch(patch);';
    expect(summarizeCodexExec(input).content).toBe('tests/x.py');
  });

  it('labels an empty write_stdin as polling', () => {
    expect(summarizeCodexExec('await tools.write_stdin({session_id:1,chars:"",yield_time_ms:10});').content).toBe('poll output');
  });
});
