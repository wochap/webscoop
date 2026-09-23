import { startPlayground } from './server';

const port = Number(process.env.PLAYGROUND_PORT ?? 4777);
const playground = await startPlayground({ port });
process.stdout.write(`playground listening on ${playground.url}\n`);
process.stdout.write(`  catalog: ${playground.url}/catalog?tier=0\n`);
process.stdout.write(`  control: ${playground.url}/__control\n`);

const shutdown = () => {
  void playground.stop().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
