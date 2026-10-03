import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function loadPromptCatalog(root) {
  const read = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
  const plugin = await read('plugins/my-crm/.codex-plugin/plugin.json');
  const contracts = await read('contracts/my-crm/v1/marketplace-prompt-contracts.json');
  const submission = await read('openai/reviewer-test-cases.json');
  const starters = plugin.interface.defaultPrompt;
  if (starters.length !== 3 || JSON.stringify(starters) !== JSON.stringify(contracts.prompts.map(row => row.text))) throw new Error('Starter configuration parity failed');
  const resolveCase = (row, kind, index) => {
    const prompt = row.starter_prompt_index === undefined ? row.user_prompt : starters[row.starter_prompt_index];
    if (!prompt?.trim() || !row.expected_output?.trim()) throw new Error('Reviewer case is incomplete');
    return {id: `${kind}-${index + 1}`, kind, prompt, expected: row.expected_output, requirements: row.requirements ?? [], allowed_effects: row.allowed_effects ?? ['read']};
  };
  const cases = [
    ...starters.map((prompt, i) => ({id: `starter-${i + 1}`, kind: 'starter', prompt, requirements: submission.test_cases.find(row => row.starter_prompt_index === i)?.requirements ?? [], allowed_effects: contracts.prompts[i].effect === 'read' ? ['read'] : ['read', 'prepare', 'draft'], expected: submission.test_cases.find(row => row.starter_prompt_index === i)?.expected_output ?? 'Fulfill the exact configured prompt using current BOS discovery; preserve source attribution and mutation safety.'})),
    ...submission.test_cases.map((row, i) => resolveCase(row, 'positive', i)),
    ...submission.negative_test_cases.map((row, i) => resolveCase(row, 'negative', i))
  ];
  const catalog = {product: plugin.name, version: plugin.version, description: plugin.interface.longDescription, short_description: plugin.description, cases};
  return {...catalog, configuration_sha256: digest(catalog)};
}
export function submissionCases(catalog) {
  const convert = row => ({user_prompt: row.prompt, expected_output: row.expected});
  return {test_cases: catalog.cases.filter(row => row.kind === 'positive').map(convert), negative_test_cases: catalog.cases.filter(row => row.kind === 'negative').map(convert)};
}
