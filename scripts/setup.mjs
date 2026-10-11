// Creates .env.local from .env.example (works on Windows, macOS and Linux).
// Never overwrites an existing .env.local.
import { copyFileSync, existsSync } from 'node:fs'

if (existsSync('.env.local')) {
  console.log('.env.local already exists — left unchanged. Open it in a text editor to change settings.')
} else {
  copyFileSync('.env.example', '.env.local')
  console.log('Created .env.local from .env.example.')
  console.log('Next: open .env.local in a text editor, set LEGENDKEEPER_API_KEY (and optionally ANTHROPIC_API_KEY), save it, then run: npm run dev')
}
