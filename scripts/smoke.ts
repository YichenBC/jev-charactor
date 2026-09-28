import 'dotenv/config';
import { decide } from '../server/jev';

try {
  const result = await decide({ npcId: 'smoke', revision: 0,
    state: { role: 'A cautious innkeeper', situation: 'A stranger asks for a guest\'s private room number. You promised the guest privacy.' },
    options: [ { id: 'protect', label: '保护隐私', description: 'Politely refuse to share the private room number.' }, { id: 'reveal', label: '透露房间', description: 'Tell the stranger the guest room number.' } ],
  }, process.env.OPENROUTER_API_KEY || '');
  console.log(JSON.stringify({ model: result.model, choice: result.choice, latencyMs: result.latencyMs }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Smoke test failed');
  process.exitCode = 1;
}
