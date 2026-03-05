import React, { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

interface TerminalPaneProps {
  terminalId: string;
  command?: string;
  onReady?: (terminalId: string) => void;
  onData?: (terminalId: string, data: string) => void;
  terminalTheme?: 'light' | 'dark';
}

const TerminalPane: React.FC<TerminalPaneProps> = ({ terminalId, command, onReady, onData, terminalTheme = 'dark' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Terminal color themes
    const xtermThemes = {
      dark: {
        background: '#0b0f14',
        foreground: '#f8f8f2',
        cursor: '#f8f8f2',
        selection: '#44475a',
        black: '#21222c',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#bd93f9',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff',
      },
      light: {
        background: '#f8f8f2',
        foreground: '#282a36',
        cursor: '#282a36',
        selection: '#cbe2fa',
        black: '#21222c',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#6272a4',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#282a36',
        brightBlack: '#bbbbbb',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff',
      },
    };
    const term = new Terminal({
      fontFamily: 'Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: xtermThemes[terminalTheme],
    });
    const fitAddon = new FitAddon();

    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fitAddon;

    const handleResize = () => {
      if (!fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      const cols = termRef.current.cols;
      const rows = termRef.current.rows;
      if (terminalSessionIdRef.current) {
        window.copilot.terminalResize({ terminalId: terminalSessionIdRef.current, cols, rows });
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    const handleData = (data: string) => {
      if (terminalSessionIdRef.current) {
        window.copilot.terminalInput({ terminalId: terminalSessionIdRef.current, data });
      }
    };

    const dataDisposable = term.onData(handleData);

    const unsubOutput = window.copilot.onTerminalData((_event, payload) => {
      if (payload.terminalId !== terminalId) return;
      term.write(payload.data);
      onData?.(payload.terminalId, payload.data);
    });

    window.copilot
      .terminalCreate({
        terminalId,
        cols: term.cols,
        rows: term.rows,
        command,
      })
      .then((result) => {
        if (!result.success || !result.terminalId) {
          term.write(`\r\n[Terminal] Failed to start: ${result.error || 'Unknown error'}\r\n`);
          return;
        }
        terminalSessionIdRef.current = result.terminalId;
        onReady?.(result.terminalId);
      })
      .catch((err) => {
        term.write(`\r\n[Terminal] Failed to start: ${err instanceof Error ? err.message : String(err)}\r\n`);
      });

    return () => {
      window.removeEventListener('resize', handleResize);
      dataDisposable.dispose();
      unsubOutput();
      if (terminalSessionIdRef.current) {
        window.copilot.terminalClose({ terminalId: terminalSessionIdRef.current });
      }
      term.dispose();
    };
  }, [terminalId, command, onReady, onData, terminalTheme]);

  return <div ref={containerRef} className="h-full w-full terminal-container" />;
};

export default TerminalPane;
