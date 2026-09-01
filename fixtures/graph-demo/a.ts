// graph-demo a.ts —— 环 a→b→c→a 的成员，并指向 hub
import { b } from './b'
import { hub } from './hub'
export const shared = 'a'
export const common = 'a'
