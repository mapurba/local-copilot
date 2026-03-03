import React, { useState } from 'react';

interface AuthModalProps {
  onComplete: (status: string, user?: string) => void;
  onClose: () => void;
}

const AuthModal: React.FC<AuthModalProps> = ({ onComplete, onClose }) => {
  const [step, setStep] = useState<'idle' | 'pending' | 'confirming' | 'done'>('idle');
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('');
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const handleSignIn = async () => {
    setStep('pending');
    setError('');
    try {
      const result = await window.copilot.signIn();
      setUserCode(result.userCode);
      setVerificationUri(result.verificationUri);
      setStep('confirming');
    } catch (_e) {
      setError('Failed to start sign-in. Make sure copilot-language-server is installed.');
      setStep('idle');
    }
  };

  const handleConfirm = async () => {
    setError('');
    setStatusMessage('Waiting for GitHub authorization...');
    try {
      const result = await window.copilot.signInConfirm(userCode);
      if (result.status === 'OK' || result.status === 'AlreadySignedIn') {
        setStep('done');
        onComplete(result.status, result.user);
      } else {
        setError(`Unexpected status: ${result.status}`);
      }
    } catch (_e) {
      setError('Sign-in confirmation failed. Please try again.');
    }
    setStatusMessage('');
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl p-8 w-[480px] shadow-2xl border border-gray-600">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-white">Sign in to GitHub Copilot</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">&times;</button>
        </div>

        {step === 'idle' && (
          <div className="space-y-4">
            <p className="text-gray-300 text-sm">
              Authenticate with GitHub to use Copilot completions and chat.
            </p>
            <button
              onClick={handleSignIn}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-4 rounded-lg transition-colors"
            >
              Sign in with GitHub
            </button>
          </div>
        )}

        {step === 'pending' && (
          <div className="flex flex-col items-center py-4">
            <div className="animate-spin w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full mb-4" />
            <p className="text-gray-300">Starting authentication...</p>
          </div>
        )}

        {step === 'confirming' && (
          <div className="space-y-4">
            <p className="text-gray-300 text-sm">
              1. Open the link below in your browser
            </p>
            <a
              href={verificationUri}
              target="_blank"
              rel="noreferrer"
              className="block bg-gray-700 rounded-lg px-4 py-2 text-blue-400 hover:text-blue-300 text-sm break-all"
            >
              {verificationUri}
            </a>
            <p className="text-gray-300 text-sm">
              2. Enter this code on GitHub:
            </p>
            <div className="bg-gray-900 rounded-lg px-4 py-3 text-center">
              <span className="text-3xl font-mono font-bold text-green-400 tracking-widest">
                {userCode}
              </span>
            </div>
            <p className="text-gray-300 text-sm">
              3. After authorizing, click &quot;I&apos;ve authorized&quot;:
            </p>
            {statusMessage && (
              <p className="text-yellow-400 text-sm text-center">{statusMessage}</p>
            )}
            <button
              onClick={handleConfirm}
              className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-4 rounded-lg transition-colors"
            >
              I&apos;ve authorized on GitHub
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center py-4">
            <div className="text-green-400 text-5xl mb-4">✓</div>
            <p className="text-gray-300">Successfully signed in!</p>
          </div>
        )}

        {error && (
          <p className="mt-4 text-red-400 text-sm bg-red-900/20 rounded p-3">{error}</p>
        )}
      </div>
    </div>
  );
};

export default AuthModal;
