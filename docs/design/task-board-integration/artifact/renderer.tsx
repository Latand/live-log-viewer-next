import { installMemoryTransport } from './transport';
import boardStyle from './board-style.css' with { type: 'text' };
// One atomic JS replacement carries matching behavior and board styles.
// The legacy link stays untouched for already-open pages running the prior bundle.
document.querySelector('link[href="/board.css"]')?.remove();
const style = document.createElement('style');
style.dataset.boardRevision = 'critique-corrections';
style.textContent = boardStyle as unknown as string;
document.head.append(style);
installMemoryTransport();
// Import after the transport is installed: native hooks cannot reach a backend.
const { createRoot } = await import('react-dom/client');
const { Viewer } = await import('@/components/Viewer');
createRoot(document.getElementById('root')!).render(<Viewer />);

const { readOutbox } = await import('@/components/conversation/outbox');
const { getRuntimeBus } = await import('@/hooks/runtimeBus');
(window as any).__productionDelivery = {readOutbox, runtime:()=>getRuntimeBus().getState()};
