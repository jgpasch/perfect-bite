// Spec 4.15: every string the app shows or speaks comes from src/i18n/. This scans src/ for JSX text
// and for accessibilityLabel / accessibilityHint / title string literals outside src/i18n/ and tests.
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import ts from 'typescript';

const SRC = join(__dirname, '..', '..');

/** Object keys (navigator options, action sheets) whose string value is shown or spoken. */
const TEXT_KEYS = new Set(['accessibilityLabel', 'accessibilityHint', 'title', 'headerTitle', 'headerBackTitle']);

/** JSX props whose string value is shown or spoken: the keys above, and the app's components' text props. */
const TEXT_PROPS = new Set([...TEXT_KEYS, 'label', 'placeholder', 'detail', 'message']);

/** Calls whose string arguments are shown: an alert's title and message, and its buttons' `text`. */
const ALERT_CALLS = new Set(['Alert.alert', 'Alert.prompt']);

/**
 * Text that genuinely isn't user-facing, by file (relative to src/, `/`-separated) and exact text.
 * Keep each entry's reason next to it.
 */
const ALLOWED: Record<string, readonly string[]> = {};

/** Files that aren't user-facing at all. */
const NOT_USER_FACING = new Set([
  // Settings > Developer: only in development builds (`__DEV__`), for debugging Siri's queue.
  'app/(tabs)/settings/developer.tsx',
]);

type Finding = { file: string; line: number; text: string };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || path === join(SRC, 'i18n') || path === join(SRC, 'test')
        ? []
        : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The literal text `node` can evaluate to: a string literal, a template's fixed parts, and the
 * literals among a conditional's branches or a `??`/`||` fallback.
 */
function literalTexts(node: ts.Node | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [[node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ')];
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node)) return literalTexts(node.expression);
  if (ts.isConditionalExpression(node)) return [...literalTexts(node.whenTrue), ...literalTexts(node.whenFalse)];
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...literalTexts(node.left), ...literalTexts(node.right)];
  }
  return [];
}

/** Whether `text` has words in it; punctuation, symbols and numbers read the same in any language. */
function hasWords(text: string): boolean {
  return /\p{L}/u.test(text);
}

function propertyName(name: ts.PropertyName | ts.JsxAttributeName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

/** Hard-coded user-facing text in one file's source. */
export function findHardCodedText(file: string, source: string): Finding[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];
  const add = (node: ts.Node, texts: string[]) => {
    for (const text of texts) {
      const trimmed = text.replace(/\s+/g, ' ').trim();
      if (!hasWords(trimmed) || ALLOWED[file]?.includes(trimmed)) continue;
      // JSX text starts with its leading whitespace; count from its first word.
      const start = node.getStart(sourceFile) + (ts.isJsxText(node) ? node.text.search(/\S/) : 0);
      const { line } = sourceFile.getLineAndCharacterOfPosition(start);
      findings.push({ file, line: line + 1, text: trimmed });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      add(node, [node.text]);
    } else if (ts.isJsxExpression(node) && ts.isJsxElement(node.parent)) {
      add(node, literalTexts(node));
    } else if (ts.isJsxAttribute(node)) {
      const name = propertyName(node.name);
      if (name && TEXT_PROPS.has(name)) add(node, literalTexts(node.initializer));
    } else if (ts.isCallExpression(node) && ALERT_CALLS.has(node.expression.getText(sourceFile))) {
      node.arguments.forEach((arg, index) => {
        // The title and message; Alert.prompt's later arguments are its keyboard type and default text.
        if (index < 2) add(arg, literalTexts(arg));
        if (!ts.isArrayLiteralExpression(arg)) return;
        for (const button of arg.elements) {
          if (!ts.isObjectLiteralExpression(button)) continue;
          for (const prop of button.properties) {
            if (ts.isPropertyAssignment(prop) && propertyName(prop.name) === 'text') add(prop, literalTexts(prop.initializer));
          }
        }
      });
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name && TEXT_KEYS.has(name)) add(node, literalTexts(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

describe('hard-coded user-facing text', () => {
  it('finds JSX text, text in braces, and accessibility props and titles', () => {
    const source = [
      'const a = <Text>Hello</Text>;',
      "const b = <Text>{'Braces'}</Text>;",
      'const c = <Pressable accessibilityLabel="Label" accessibilityHint={`Hint`} />;',
      "const d = { title: 'Title' };",
      "const e = <Stack.Screen options={{ title: 'Screen' }} />;",
      'const f = <Button label="Save" />;',
      "Alert.alert('Delete?', 'Gone for good.', [{ text: 'Cancel', style: 'cancel' }]);",
      "const g = <Button label={busy ? 'Saving…' : `Save ${name}`} detail={note ?? 'None'} />;",
    ].join('\n');
    expect(findHardCodedText('example.tsx', source)).toEqual([
      { file: 'example.tsx', line: 1, text: 'Hello' },
      { file: 'example.tsx', line: 2, text: 'Braces' },
      { file: 'example.tsx', line: 3, text: 'Label' },
      { file: 'example.tsx', line: 3, text: 'Hint' },
      { file: 'example.tsx', line: 4, text: 'Title' },
      { file: 'example.tsx', line: 5, text: 'Screen' },
      { file: 'example.tsx', line: 6, text: 'Save' },
      { file: 'example.tsx', line: 7, text: 'Delete?' },
      { file: 'example.tsx', line: 7, text: 'Gone for good.' },
      { file: 'example.tsx', line: 7, text: 'Cancel' },
      { file: 'example.tsx', line: 8, text: 'Saving…' },
      { file: 'example.tsx', line: 8, text: 'Save' },
      { file: 'example.tsx', line: 8, text: 'None' },
    ]);
  });

  it('ignores translated text, symbols, other props, and whitespace', () => {
    const source = [
      "const a = <Text accessibilityLabel={t('x.y')}>{t('x.z')}</Text>;",
      'const b = <Text>  ·  </Text>;',
      'const c = <Text>{count} × 2</Text>;',
      'const d = <View testID="row" accessibilityRole="button" />;',
      'const e = <Text>{`${name}`}</Text>;',
      "const f = { name: 'Not text', label: 'A label outside JSX' };",
      "Alert.alert(t('a.title'), undefined, [{ text: t('common.cancel'), style: 'cancel' }]);",
      "other.alert('Not an alert');",
      "Alert.prompt(t('a.title'), undefined, onSave, 'plain-text', 'Typed name');",
    ].join('\n');
    expect(findHardCodedText('example.tsx', source)).toEqual([]);
  });

  it('collapses whitespace in multi-line JSX text', () => {
    expect(findHardCodedText('a.tsx', 'const a = <Text>\n  Two\n  lines\n</Text>;')).toEqual([
      { file: 'a.tsx', line: 2, text: 'Two lines' },
    ]);
  });

  it('finds none in src/ outside src/i18n/', () => {
    const findings = sourceFiles(SRC).flatMap((path) => {
      const file = relative(SRC, path).split(sep).join('/');
      return NOT_USER_FACING.has(file) ? [] : findHardCodedText(file, readFileSync(path, 'utf8'));
    });
    expect(findings.map(({ file, line, text }) => `${file}:${line} ${text}`)).toEqual([]);
  });
});
