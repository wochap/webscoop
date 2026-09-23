import { defaultIo, main } from './main';

const code = await main(process.argv.slice(2), defaultIo());
// Let stdout drain before exiting so piped consumers get every byte.
process.stdout.write('', () => process.exit(code));
