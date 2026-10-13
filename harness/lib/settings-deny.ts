/**
 * 配る deny の雛形（harness/templates/claude-settings.deny.json）の `{{defaultBranch}}` を、導入先の既定ブランチで埋める。
 * 既定ブランチへの push の3行がこの置き場所を持つ。sync（planSettings）が使う。
 */
export const DEFAULT_BRANCH_PLACEHOLDER = '{{defaultBranch}}';

/** 雛形の行に置き場所があるか */
export function hasDefaultBranchPlaceholder(template: string[]): boolean {
  return template.some((row) => row.includes(DEFAULT_BRANCH_PLACEHOLDER));
}

/** deny の規則の中で壊れ方をしうる名前を弾く（空・前後の空白・空白・* ( ) { }・..・先頭の -・末尾の / と .lock） */
function assertBranchName(name: string): void {
  if (
    name === '' ||
    name !== name.trim() ||
    /[\s*(){}]/.test(name) ||
    name.includes('..') ||
    name.startsWith('-') ||
    name.endsWith('/') ||
    name.endsWith('.lock')
  ) {
    throw new Error(`既定ブランチの名前が deny の規則に使えない: ${JSON.stringify(name)}`);
  }
}

/** 雛形の各行の `{{defaultBranch}}` をすべて defaultBranch に置き換えた新しい配列を返す（入力は変えない） */
export function renderDeny(template: string[], defaultBranch: string): string[] {
  assertBranchName(defaultBranch);
  return template.map((row) => {
    const out = row.split(DEFAULT_BRANCH_PLACEHOLDER).join(defaultBranch);
    if (out.includes('{{')) throw new Error(`deny の行に埋まらない置き場所が残っている: ${row}`);
    return out;
  });
}
