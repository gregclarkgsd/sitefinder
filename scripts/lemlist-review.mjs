import { readFileSync } from 'node:fs';
import { initializeReview, reviewInsert } from '../lemlist-review.js';

const [action, store, input] = process.argv.slice(2);
if (!['init', 'review'].includes(action) || !store || !input) {
  console.error('Usage: node scripts/lemlist-review.mjs <init|review> <local-store.json> <input.json>');
  process.exitCode = 1;
} else {
  try {
    const data = JSON.parse(readFileSync(input, 'utf8'));
    const result = action === 'init' ? initializeReview(store, data) : reviewInsert(store, data.event, data.evidence);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Review stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
