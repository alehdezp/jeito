import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getParser } from '../extraction/grammars';

/** Syntactic consistency only: aliases, imports and method sets still need Go binding. */
export function goMethodSignatureKey(signature: string): string | undefined {
  const parser = getParser('go');
  if (!parser || !signature) return undefined;
  let tree: ReturnType<typeof parser.parse> = null;
  try {
    tree = parser.parse(`package p\ntype S interface { M${signature} }\n`);
    if (!tree || tree.rootNode.hasError || tree.rootNode.namedChildCount !== 2) return undefined;
    const body = tree.rootNode.namedChild(1)?.namedChild(0)?.childForFieldName('type');
    const methods = body?.namedChildren.filter(node => node.type !== 'comment');
    if (methods?.length !== 1 || !['method_elem', 'method_spec'].includes(methods[0]!.type)) return undefined;
    return JSON.stringify(callable(methods[0]!));
  } finally {
    tree?.delete();
  }
}

function callable(node: SyntaxNode): unknown {
  const result = node.childForFieldName('result');
  return [parameters(node.childForFieldName('parameters')),
    result?.type === 'parameter_list' ? parameters(result) : result ? [[JSON.stringify([false, typeKey(result)]), 1]] : []];
}

function parameters(list: SyntaxNode | null): unknown[] {
  const types: [string, number][] = [];
  for (const parameter of list?.namedChildren ?? []) {
    if (parameter.type === 'comment') continue;
    const type = parameter.childForFieldName('type');
    if (!type) throw new Error('Go parameter type unavailable');
    const key = JSON.stringify([parameter.type === 'variadic_parameter_declaration', typeKey(type)]);
    const count = Math.max(1, parameter.childrenForFieldName('name').length);
    const previous = types.at(-1);
    // Grouped names and separate same-type declarations describe the same slots,
    // without copying a large type once per declared name.
    if (previous?.[0] === key) previous[1] += count;
    else types.push([key, count]);
  }
  return types;
}

function typeKey(node: SyntaxNode): unknown {
  if (node.type === 'function_type') return ['function_type', callable(node)];
  if (node.type === 'method_elem' || node.type === 'method_spec') {
    return ['method', node.childForFieldName('name')?.text, callable(node)];
  }
  if (node.childCount === 0) return [node.type, node.text];
  // Ignore formatting/comments, not spaces or escapes inside string/tag tokens.
  return [node.type, node.children.filter(child => child.type !== 'comment').map(typeKey)];
}
