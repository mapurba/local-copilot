import React, { useEffect, useState } from 'react';

interface ProviderConfigView {
  provider: 'copilot' | 'bedrock';
  bedrock: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    modelId: string;
    configured: boolean;
  };
}

interface AuthModalProps {
  onComplete: (status: string, user?: string) => void;
  onClose: () => void;
  providerConfig: ProviderConfigView | null;
  onProviderConfigChange: (cfg: ProviderConfigView) => void;
  theme?: 'light' | 'dark';
  copilotAuthStatus?: string;
  copilotUser?: string;
}

const BEDROCK_MODELS = [
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-3-7-sonnet-20250219-v1:0',
  'amazon.nova-pro-v1:0',
];

const AuthModal: React.FC<AuthModalProps> = ({
  onComplete,
  onClose,
  providerConfig,
  onProviderConfigChange,
  theme = 'dark',
  copilotAuthStatus,
  copilotUser,
}) => {
  const isLight = theme === 'light';
  const copilotConnected = copilotAuthStatus === 'OK' || copilotAuthStatus === 'AlreadySignedIn';
  const [selectedProvider, setSelectedProvider] = useState<'copilot' | 'bedrock'>(providerConfig?.provider ?? 'copilot');
  const [step, setStep] = useState<'idle' | 'pending' | 'confirming' | 'done'>('idle');
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('');
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [savingBedrock, setSavingBedrock] = useState(false);
  const [bedrockAccessKeyId, setBedrockAccessKeyId] = useState(providerConfig?.bedrock.accessKeyId || '');
  const [bedrockSecretAccessKey, setBedrockSecretAccessKey] = useState(providerConfig?.bedrock.secretAccessKey || '');
  const [bedrockRegion, setBedrockRegion] = useState(providerConfig?.bedrock.region || '');
  const [bedrockModelId, setBedrockModelId] = useState(providerConfig?.bedrock.modelId || BEDROCK_MODELS[0]);

  useEffect(() => {
    if (!providerConfig) return;
    setSelectedProvider(providerConfig.provider);
    setBedrockAccessKeyId(providerConfig.bedrock.accessKeyId || '');
    setBedrockSecretAccessKey(providerConfig.bedrock.secretAccessKey || '');
    setBedrockRegion(providerConfig.bedrock.region || '');
    setBedrockModelId(providerConfig.bedrock.modelId || BEDROCK_MODELS[0]);
  }, [providerConfig]);

  const switchProvider = async (provider: 'copilot' | 'bedrock') => {
    setError('');
    try {
      const updated = await window.copilot.setProvider(provider);
      onProviderConfigChange(updated);
      setSelectedProvider(provider);
      if (provider === 'copilot') {
        setStep('idle');
      }
      if (provider === 'bedrock' && updated.bedrock.configured) {
        setStatusMessage('Bedrock is active. Copilot session remains intact and can be switched back anytime.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to switch provider');
    }
  };

  const handleSaveBedrock = async () => {
    setError('');
    setStatusMessage('');
    if (!bedrockAccessKeyId.trim() || !bedrockSecretAccessKey.trim() || !bedrockRegion.trim() || !bedrockModelId.trim()) {
      setError('Access key, secret key, region, and model are required for Bedrock.');
      return;
    }

    setSavingBedrock(true);
    try {
      const updated = await window.copilot.saveBedrockConfig({
        accessKeyId: bedrockAccessKeyId.trim(),
        secretAccessKey: bedrockSecretAccessKey.trim(),
        region: bedrockRegion.trim(),
        modelId: bedrockModelId,
      });
      onProviderConfigChange(updated);
      setSelectedProvider('bedrock');
      setStatusMessage('Bedrock configuration saved and activated.');
      setStep('idle');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save Bedrock configuration');
    } finally {
      setSavingBedrock(false);
    }
  };

  const handleSignIn = async () => {
    setStep('pending');
    setError('');
    try {
      const result = await window.copilot.signIn();
      if (result.status === 'AlreadySignedIn') {
        setStep('done');
        onComplete(result.status, result.user);
        return;
      }
      setUserCode(result.userCode);
      setVerificationUri(result.verificationUri);
      setStep('confirming');
      window.copilot.openExternal(result.verificationUri);
    } catch (_e) {
      setError('Failed to start sign-in. Make sure copilot-language-server is installed.');
      setStep('idle');
    }
  };

  const handleConfirm = async () => {
    setError('');
    setStatusMessage('Waiting for GitHub authorization...');
    try {
      const result = await window.copilot.signInConfirm();
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
    <div className={`fixed inset-0 flex items-center justify-center z-50 ${isLight ? 'bg-black/35' : 'bg-black/70'}`}>
      <div className={`${isLight ? 'bg-white border-gray-300' : 'bg-gray-800 border-gray-600'} rounded-xl p-8 w-[480px] shadow-2xl border`}>
        <div className="flex justify-between items-center mb-6">
          <h2 className={`text-xl font-bold ${isLight ? 'text-gray-900' : 'text-white'}`}>AI Provider</h2>
          <button onClick={onClose} className={`${isLight ? 'text-gray-500 hover:text-gray-800' : 'text-gray-400 hover:text-white'} text-2xl leading-none`}>&times;</button>
        </div>

        <div className="mb-5 flex gap-2">
          <button
            onClick={() => { void switchProvider('copilot'); }}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${selectedProvider === 'copilot' ? 'bg-blue-600 text-white' : (isLight ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-gray-700 text-gray-300 hover:bg-gray-650')}`}
          >
            Copilot
          </button>
          <button
            onClick={() => { void switchProvider('bedrock'); }}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${selectedProvider === 'bedrock' ? 'bg-blue-600 text-white' : (isLight ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-gray-700 text-gray-300 hover:bg-gray-650')}`}
          >
            Bedrock
          </button>
        </div>

        {selectedProvider === 'bedrock' && (
          <div className="space-y-4">
            <p className={`${isLight ? 'text-gray-700' : 'text-gray-300'} text-sm`}>
              Configure AWS Bedrock. This is persisted locally and does not log out your Copilot account.
            </p>

            <div>
              <label className={`block text-xs mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>Access Key ID</label>
              <input
                value={bedrockAccessKeyId}
                onChange={(e) => setBedrockAccessKeyId(e.target.value)}
                className={`w-full rounded px-3 py-2 text-sm ${isLight ? 'bg-white border border-gray-300 text-gray-900' : 'bg-gray-900 border border-gray-600 text-gray-100'}`}
                placeholder="AKIA..."
              />
            </div>

            <div>
              <label className={`block text-xs mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>Secret Access Key</label>
              <input
                type="password"
                value={bedrockSecretAccessKey}
                onChange={(e) => setBedrockSecretAccessKey(e.target.value)}
                className={`w-full rounded px-3 py-2 text-sm ${isLight ? 'bg-white border border-gray-300 text-gray-900' : 'bg-gray-900 border border-gray-600 text-gray-100'}`}
                placeholder="AWS secret access key"
              />
            </div>

            <div>
              <label className={`block text-xs mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>Region</label>
              <input
                value={bedrockRegion}
                onChange={(e) => setBedrockRegion(e.target.value)}
                className={`w-full rounded px-3 py-2 text-sm ${isLight ? 'bg-white border border-gray-300 text-gray-900' : 'bg-gray-900 border border-gray-600 text-gray-100'}`}
                placeholder="us-east-1"
              />
            </div>

            <div>
              <label className={`block text-xs mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>Model</label>
              <select
                value={bedrockModelId}
                onChange={(e) => setBedrockModelId(e.target.value)}
                className={`w-full rounded px-3 py-2 text-sm ${isLight ? 'bg-white border border-gray-300 text-gray-900' : 'bg-gray-900 border border-gray-600 text-gray-100'}`}
              >
                {BEDROCK_MODELS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            <button
              onClick={() => { void handleSaveBedrock(); }}
              disabled={savingBedrock}
              className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white font-semibold py-3 px-4 rounded-lg transition-colors"
            >
              {savingBedrock ? 'Saving...' : 'Save and Use Bedrock'}
            </button>
          </div>
        )}

        {selectedProvider === 'copilot' && step === 'idle' && copilotConnected && (
          <div className="space-y-4">
            <div className={`rounded-lg p-3 border ${isLight ? 'bg-green-50 border-green-200 text-green-800' : 'bg-green-900/20 border-green-800 text-green-300'}`}>
              Connected to Copilot{copilotUser ? ` as ${copilotUser}` : ''}.
            </div>
            <button
              onClick={handleSignIn}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-4 rounded-lg transition-colors"
            >
              Reconnect Copilot
            </button>
          </div>
        )}

        {selectedProvider === 'copilot' && step === 'idle' && !copilotConnected && (
          <div className="space-y-4">
            <p className={`${isLight ? 'text-gray-700' : 'text-gray-300'} text-sm`}>
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

        {selectedProvider === 'copilot' && step === 'pending' && (
          <div className="flex flex-col items-center py-4">
            <div className="animate-spin w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full mb-4" />
            <p className={isLight ? 'text-gray-700' : 'text-gray-300'}>Starting authentication...</p>
          </div>
        )}

        {selectedProvider === 'copilot' && step === 'confirming' && (
          <div className="space-y-4">
            <p className={`${isLight ? 'text-gray-700' : 'text-gray-300'} text-sm`}>
              1. Open the link below in your browser
            </p>
            <a
              href={verificationUri}
              onClick={(e) => { e.preventDefault(); window.copilot.openExternal(verificationUri); }}
              className={`block rounded-lg px-4 py-2 text-sm break-all cursor-pointer ${isLight ? 'bg-gray-100 text-blue-600 hover:text-blue-700' : 'bg-gray-700 text-blue-400 hover:text-blue-300'}`}
            >
              {verificationUri}
            </a>
            <p className={`${isLight ? 'text-gray-700' : 'text-gray-300'} text-sm`}>
              2. Enter this code on GitHub:
            </p>
            <div className={`rounded-lg px-4 py-3 text-center ${isLight ? 'bg-gray-100' : 'bg-gray-900'}`}>
              <span className="text-3xl font-mono font-bold text-green-400 tracking-widest">
                {userCode}
              </span>
            </div>
            <p className={`${isLight ? 'text-gray-700' : 'text-gray-300'} text-sm`}>
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

        {selectedProvider === 'copilot' && step === 'done' && (
          <div className="flex flex-col items-center py-4">
            <div className="text-green-400 text-5xl mb-4">✓</div>
            <p className={isLight ? 'text-gray-700' : 'text-gray-300'}>Successfully signed in!</p>
          </div>
        )}

        {statusMessage && (
          <p className={`mt-4 text-sm rounded p-3 ${isLight ? 'text-green-700 bg-green-100' : 'text-green-300 bg-green-900/20'}`}>{statusMessage}</p>
        )}

        {error && (
          <p className="mt-4 text-red-400 text-sm bg-red-900/20 rounded p-3">{error}</p>
        )}
      </div>
    </div>
  );
};

export default AuthModal;
