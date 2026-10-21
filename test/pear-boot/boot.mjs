// This entrypoint runs inside Bare. Import the actual worker after checking
// the editor helper that previously crashed the entire shared module graph.
import { slashQuery } from '@listam/domain/board'

if (slashQuery('/table2') !== 'table2' || slashQuery('/with space') !== null) {
    throw new Error('Slash query compatibility failed')
}

await import('./src/backend-worker.mjs')
