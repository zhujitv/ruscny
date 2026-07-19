import { buildApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import {
  startAudioDeletionWorker,
  type AudioDeletionWorker,
} from './services/audio-deletion-outbox.js';
import {
  startSummaryEmailWorker,
  type SummaryEmailWorker,
} from './routes/summary-email.js';
import {
  startTtsGenerationWorker,
  type TtsGenerationWorker,
} from './services/tts-generation.js';

const app = await buildApp();
let audioDeletionWorker: AudioDeletionWorker | undefined;
let summaryEmailWorker: SummaryEmailWorker | undefined;
let ttsGenerationWorker: TtsGenerationWorker | undefined;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await audioDeletionWorker?.stop();
  await summaryEmailWorker?.stop();
  await ttsGenerationWorker?.stop();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  audioDeletionWorker = startAudioDeletionWorker({ logger: app.log });
  summaryEmailWorker = startSummaryEmailWorker({ logger: app.log });
  ttsGenerationWorker = startTtsGenerationWorker({ logger: app.log });
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exit(1);
}
