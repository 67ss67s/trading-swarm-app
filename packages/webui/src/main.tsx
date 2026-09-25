import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { isGatewayUnavailable } from './api/client';
import './index.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 网关重启期间多试几次(约 1 分钟);更久的中断由 SSE 重连后的整页刷新兜底。业务错误仍只重试 1 次。
      retry: (count, err) => (isGatewayUnavailable(err) ? count < 8 : count < 1),
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8_000),
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(el).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
