import React from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import '@cui-styles';
import { App } from './App';
import { initTelemetry } from './telemetry';

initTelemetry();

function Fallback({ error }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: '#fa7311' }}>
      <h2>Something broke</h2>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{message}</pre>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary FallbackComponent={Fallback}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
