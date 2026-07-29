import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(pbkdf2);
const terminal = createInterface({ input: stdin, output: stdout });
try {
  const password = await terminal.question('输入作者密码（终端可能显示输入）：');
  if (!password) throw new Error('密码不能为空');
  const salt = randomBytes(24);
  const iterations = 210_000;
  const hash = await derive(password, salt, iterations, 32, 'sha256');
  stdout.write(`\npbkdf2$${iterations}$${salt.toString('hex')}$${hash.toString('hex')}\n`);
} finally {
  terminal.close();
}

