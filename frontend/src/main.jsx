import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import './styles.css';

const API = 'http://localhost:8001/api';
const token = () => localStorage.getItem('token');
const getUser = () => {
  try {
    return JSON.parse(localStorage.getItem('user'));
  } catch {
    return null;
  }
};

async function api(path, opts = {}, retryCount = 0) {
  const headers = {
    'Content-Type': 'application/json',
    ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
    ...(opts.headers || {}),
  };
  try {
    const res = await fetch(API + path, { ...opts, headers, credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/register') && !path.startsWith('/auth/send-') && !path.startsWith('/auth/reset-')) {
        localStorage.clear();
        window.dispatchEvent(new Event('auth:unauthorized'));
      }
      throw new Error(data.message || data.detail || 'Request failed');
    }
    return data;
  } catch (err) {
    // If network error (e.g. Failed to fetch on cold start / preflight), retry once automatically
    if (retryCount < 1 && (err.name === 'TypeError' || (err.message && err.message.toLowerCase().includes('failed to fetch')))) {
      await new Promise((r) => setTimeout(r, 200));
      return api(path, opts, retryCount + 1);
    }
    throw err;
  }
}


function ThemeToggle() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggle = () => {
    setTheme(t => (t === 'light' ? 'dark' : 'light'));
  };

  return (
    <button
      type="button"
      className="theme-toggle-btn"
      onClick={toggle}
      title={theme === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
      aria-label="Toggle theme"
    >
      {theme === 'light' ? '🌙 Dark' : '☀️ Light'}
    </button>
  );
}

function OtpInput({ length = 6, value = '', onChange, disabled = false }) {
  const inputsRef = useRef([]);

  const digits = Array.from({ length }, (_, i) => value[i] || '');

  const handleChange = (e, index) => {
    const val = e.target.value.replace(/\D/g, '');
    const char = val.slice(-1);
    const newDigits = [...digits];
    newDigits[index] = char;
    const combined = newDigits.join('');
    onChange(combined);

    if (char && index < length - 1) {
      inputsRef.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (e, index) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const paste = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    onChange(paste);
    const targetIdx = Math.min(paste.length, length - 1);
    inputsRef.current[targetIdx]?.focus();
  };

  return (
    <div className="otp-grid" onPaste={handlePaste}>
      {Array.from({ length }).map((_, idx) => (
        <input
          key={idx}
          ref={(el) => (inputsRef.current[idx] = el)}
          type="text"
          inputMode="numeric"
          maxLength={1}
          disabled={disabled}
          value={digits[idx] || ''}
          onChange={(e) => handleChange(e, idx)}
          onKeyDown={(e) => handleKeyDown(e, idx)}
          className="otp-input"
          autoComplete="off"
        />
      ))}
    </div>
  );
}

function EmailVerifyModal({ user, onClose, onVerified }) {
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    let timer;
    if (countdown > 0) {
      timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    }
    return () => clearTimeout(timer);
  }, [countdown]);

  async function handleVerify(e) {
    e.preventDefault();
    if (otp.length !== 6) {
      setErr('Please enter the full 6-digit OTP');
      return;
    }
    setLoading(true);
    setErr('');
    setMsg('');
    try {
      const res = await api('/auth/verify-account', {
        method: 'POST',
        body: JSON.stringify({ otp }),
      });
      if (!res.success) {
        throw new Error(res.message || 'Verification failed');
      }
      setMsg('✅ ' + (res.message || 'Email verified successfully!'));
      const updatedUser = { ...user, isAccountVerified: true };
      localStorage.setItem('user', JSON.stringify(updatedUser));
      setTimeout(() => {
        onVerified(updatedUser);
        onClose();
      }, 1000);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (countdown > 0 || resending) return;
    setResending(true);
    setErr('');
    setMsg('');
    try {
      const res = await api('/auth/resend-otp', { method: 'POST' });
      if (!res.success) {
        throw new Error(res.message || 'Could not resend OTP');
      }
      setMsg('✉️ New OTP sent to your email!');
      setCountdown(60);
    } catch (e) {
      setErr(e.message);
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="auth-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="auth-modal-card glass-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Verify Your Email</h2>
          <button type="button" onClick={onClose} className="secondary-btn" style={{ padding: '4px 10px' }}>✕</button>
        </div>
        <p className="subtitle" style={{ marginBottom: '8px' }}>
          Enter the 6-digit code sent to <strong>{user?.email}</strong>
        </p>

        <form onSubmit={handleVerify}>
          <OtpInput value={otp} onChange={setOtp} disabled={loading} />

          {err && <div className="error-badge" style={{ marginBottom: '12px' }}>{err}</div>}
          {msg && <div style={{ color: '#10b981', fontSize: '13px', textAlign: 'center', marginBottom: '12px', fontWeight: 'bold' }}>{msg}</div>}

          <button type="submit" className="primary-btn" style={{ width: '100%', padding: '12px' }} disabled={loading}>
            {loading ? 'Verifying...' : 'Verify Email'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: '16px', fontSize: '13px', color: 'var(--text-muted)' }}>
          Didn't receive the code?{' '}
          <button
            type="button"
            onClick={handleResend}
            disabled={countdown > 0 || resending}
            style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: countdown > 0 ? 'default' : 'pointer', fontWeight: 600, padding: 0 }}
          >
            {countdown > 0 ? `Resend in ${countdown}s` : resending ? 'Sending...' : 'Resend OTP'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetPasswordModal({ onClose }) {
  const [step, setStep] = useState(1); // 1: Email, 2: OTP, 3: New Password
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  async function handleSendOtp(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setErr('');
    try {
      const res = await api('/auth/send-reset-otp', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.success) throw new Error(res.message || 'Failed to send OTP');
      setMsg('OTP sent to your email!');
      setStep(2);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleVerifyOtpStep(e) {
    e.preventDefault();
    if (otp.length !== 6) {
      setErr('Please enter the 6-digit OTP');
      return;
    }
    setErr('');
    setStep(3);
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    if (!newPassword || newPassword.length < 6) {
      setErr('Password must be at least 6 characters');
      return;
    }
    setLoading(true);
    setErr('');
    try {
      const res = await api('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), otp, newPassword }),
      });
      if (!res.success) throw new Error(res.message || 'Failed to reset password');
      setMsg('✅ ' + (res.message || 'Password reset successfully!'));
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="auth-modal-card glass-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Reset Password</h2>
          <button type="button" onClick={onClose} className="secondary-btn" style={{ padding: '4px 10px' }}>✕</button>
        </div>

        {step === 1 && (
          <form onSubmit={handleSendOtp}>
            <p className="subtitle">Enter your registered email address to receive a 6-digit reset code.</p>
            <div className="form-group">
              <label>Email Address</label>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            {err && <div className="error-badge" style={{ marginBottom: '12px' }}>{err}</div>}
            <button type="submit" className="primary-btn" style={{ width: '100%', padding: '12px' }} disabled={loading}>
              {loading ? 'Sending OTP...' : 'Send Reset Code'}
            </button>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={handleVerifyOtpStep}>
            <p className="subtitle">Enter the 6-digit code sent to <strong>{email}</strong></p>
            <OtpInput value={otp} onChange={setOtp} />
            {err && <div className="error-badge" style={{ marginBottom: '12px' }}>{err}</div>}
            <button type="submit" className="primary-btn" style={{ width: '100%', padding: '12px' }}>
              Continue
            </button>
          </form>
        )}

        {step === 3 && (
          <form onSubmit={handleResetPassword}>
            <p className="subtitle">Enter your new secure password.</p>
            <div className="form-group">
              <label>New Password</label>
              <input
                type="password"
                placeholder="••••••••"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={6}
              />
            </div>
            {err && <div className="error-badge" style={{ marginBottom: '12px' }}>{err}</div>}
            {msg && <div style={{ color: '#10b981', fontSize: '13px', textAlign: 'center', marginBottom: '12px', fontWeight: 'bold' }}>{msg}</div>}
            <button type="submit" className="primary-btn" style={{ width: '100%', padding: '12px' }} disabled={loading}>
              {loading ? 'Resetting...' : 'Save New Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function Login({ onLogin }) {
  const [tab, setTab] = useState('login'); // 'login' | 'register'
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('student');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForgotModal, setShowForgotModal] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const isReg = tab === 'register';
      const endpoint = isReg ? '/auth/register' : '/auth/login';
      const body = isReg ? { name, email, password, role } : { email, password };
      const d = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });

      if (d.success === false) {
        throw new Error(d.message || 'Authentication failed');
      }

      const authToken = d.token || d.access_token;
      if (!authToken) throw new Error('Authentication token missing');

      localStorage.setItem('token', authToken);
      localStorage.setItem('user', JSON.stringify(d.user));
      onLogin(d.user);
    } catch (x) {
      setErr(x.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="center">
      <form className="card glass-card" onSubmit={submit}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div className="brand-header" style={{ marginBottom: 0 }}>
            <div className="shield-icon">🛡️</div>
            <h1>Secure Exam Portal</h1>
          </div>
          <ThemeToggle />
        </div>

        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab-btn ${tab === 'login' ? 'active' : ''}`}
            onClick={() => { setErr(''); setTab('login'); }}
          >
            Sign In
          </button>
          <button
            type="button"
            className={`auth-tab-btn ${tab === 'register' ? 'active' : ''}`}
            onClick={() => { setErr(''); setTab('register'); }}
          >
            Create Account
          </button>
        </div>

        <p className="subtitle">
          {tab === 'register' ? 'Register for your portal account' : 'Sign in to access your exams and dashboard'}
        </p>

        {tab === 'register' && (
          <div className="form-group">
            <label>Full Name</label>
            <input
              placeholder="e.g. Jane Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
        )}

        <div className="form-group">
          <label>Email Address</label>
          <input
            type="email"
            placeholder="user@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label style={{ margin: 0 }}>Password</label>
            {tab === 'login' && (
              <button
                type="button"
                className="link-btn"
                style={{ fontSize: '12px', padding: 0 }}
                onClick={() => setShowForgotModal(true)}
              >
                Forgot Password?
              </button>
            )}
          </div>
          <input
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />
        </div>

        {tab === 'register' && (
          <div className="form-group">
            <label>Register as</label>
            <div className="role-selector">
              <button
                type="button"
                className={`role-btn ${role === 'student' ? 'active' : ''}`}
                onClick={() => setRole('student')}
              >
                🎓 Student
              </button>
              <button
                type="button"
                className={`role-btn ${role === 'faculty' ? 'active' : ''}`}
                onClick={() => setRole('faculty')}
              >
                🏫 Faculty
              </button>
            </div>
          </div>
        )}

        <button type="submit" className="primary-btn" disabled={loading}>
          {loading ? 'Please wait...' : tab === 'register' ? 'Register Account' : 'Sign In'}
        </button>

        {err && <div className="error-badge">{err}</div>}


      </form>

      {showForgotModal && (
        <ResetPasswordModal onClose={() => setShowForgotModal(false)} />
      )}
    </div>
  );
}

function PasswordReauthModal({ onVerified, onCancel }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');

  async function verify(e) {
    e.preventDefault();
    setErr('');
    try {
      await api('/auth/reauth', {
        method: 'POST',
        body: JSON.stringify({ password: pw }),
      });
      onVerified();
    } catch (e) {
      setErr(e.message || 'Password verification failed');
    }
  }

  return (
    <div className="center">
      <div className="card glass-card">
        <div className="badge-chip warning">🔒 Password Verification Required</div>
        <h2>Re-enter Password</h2>
        <p className="subtitle">
          For security enforcement, please confirm your password to unlock the exam session.
        </p>
        <form onSubmit={verify}>
          <div className="form-group">
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Account password"
              autoFocus
              required
            />
          </div>
          {err && <div className="error-badge">{err}</div>}
          <div className="btn-group">
            <button type="submit" className="primary-btn">
              Verify & Continue
            </button>
            <button type="button" className="secondary-btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CameraCheck({ requiredCamera = true, requiredMic = true, onReady, onCancel }) {
  const video = useRef(null);
  const stream = useRef(null);
  const handedOff = useRef(false);
  const [camera, setCamera] = useState(false);
  const [mic, setMic] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    return () => {
      if (stream.current && !handedOff.current) {
        stream.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  async function start() {
    setError('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      stream.current = s;
      if (video.current) video.current.srcObject = s;
      setCamera(s.getVideoTracks().some((t) => t.readyState === 'live'));
      setMic(s.getAudioTracks().some((t) => t.readyState === 'live'));
    } catch (e) {
      setError('Camera and microphone permissions are mandatory for this proctored exam.');
    }
  }

  const ready = (!requiredCamera || camera) && (!requiredMic || mic);

  return (
    <div className="center">
      <div className="card glass-card">
        <div className="badge-chip info">🎥 Mandatory System Check</div>
        <h2>Proctoring Setup</h2>
        <p className="subtitle">Ensure your webcam and microphone are operational.</p>

        <video ref={video} autoPlay muted playsInline className="preview-video" />

        <div className="status-row">
          <span className={`status-pill ${camera ? 'active' : 'inactive'}`}>
            {camera ? '✓ Camera Active' : '✗ Camera Inactive'}
          </span>
          <span className={`status-pill ${mic ? 'active' : 'inactive'}`}>
            {mic ? '✓ Mic Active' : '✗ Mic Inactive'}
          </span>
        </div>

        {error && <div className="error-badge">{error}</div>}

        <div className="btn-group">
          {!ready && (
            <button type="button" className="primary-btn" onClick={start}>
              Enable Camera & Mic
            </button>
          )}
          {ready && (
            <button
              type="button"
              className="primary-btn success"
              onClick={() => {
                handedOff.current = true;
                onReady(stream.current);
              }}
            >
              Start Exam (Enter Fullscreen)
            </button>
          )}
          <button type="button" className="secondary-btn" onClick={onCancel}>
            Exit
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Camera Proctoring Hook ───────────────────────────────────────
// Runs continuous face detection on the video stream every ANALYSIS_INTERVAL ms.
// Uses the browser's FaceDetector API when available (Chromium), otherwise falls
// back to a canvas-based skin-tone pixel heuristic.

function useAudioProctor(stream, onAiEvent, active) {
  const cooldowns = useRef({});
  const warmupCountRef = useRef(0);
  const baselineRef = useRef(35);
  const speechCountRef = useRef(0);

  const canFire = useCallback((eventType) => {
    const now = Date.now();
    const last = cooldowns.current[eventType] || 0;
    if (now - last < 30000) return false;
    cooldowns.current[eventType] = now;
    return true;
  }, []);

  useEffect(() => {
    if (!stream || !active) return;
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;

    let intervalId = null;
    let audioCtx = null;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);

      const freqData = new Uint8Array(analyser.frequencyBinCount);
      const timeData = new Uint8Array(analyser.fftSize);

      warmupCountRef.current = 0;
      baselineRef.current = 35;
      speechCountRef.current = 0;

      intervalId = setInterval(() => {
        analyser.getByteFrequencyData(freqData);
        analyser.getByteTimeDomainData(timeData);

        // 1. Time-domain RMS volume (0.0 to 1.0)
        let sumSquares = 0;
        for (let i = 0; i < timeData.length; i++) {
          const norm = (timeData[i] - 128) / 128;
          sumSquares += norm * norm;
        }
        const rms = Math.sqrt(sumSquares / timeData.length);

        // 2. Voice-band energy (300Hz to 3000Hz -> bins 4 to 35)
        let voiceSum = 0;
        for (let i = 4; i <= 35; i++) {
          voiceSum += freqData[i];
        }
        const voiceLevel = voiceSum / 32;

        // 3. Warm-up calibration (first 8 checks = ~5.6s)
        if (warmupCountRef.current < 8) {
          warmupCountRef.current += 1;
          baselineRef.current = Math.max(baselineRef.current, voiceLevel);
          return;
        }

        // Slowly track ambient background level
        baselineRef.current = baselineRef.current * 0.96 + voiceLevel * 0.04;

        // 4. Genuine vocal speech requires high volume + significant voice-band spike above baseline
        const isSpeaking = (rms > 0.15 && voiceLevel > baselineRef.current + 35) || voiceLevel > 110;

        if (isSpeaking) {
          speechCountRef.current += 1;
          if (speechCountRef.current >= 3) {
            if (canFire('SPEECH_NOISE_DETECTED') && onAiEvent) {
              onAiEvent('SPEECH_NOISE_DETECTED', 0.94);
            }
          }
        } else {
          speechCountRef.current = 0;
        }
      }, 700);
    } catch (err) {
      console.warn('Audio proctoring unavailable:', err);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
    };
  }, [stream, active, onAiEvent, canFire]);
}

const ANALYSIS_INTERVAL = 1500; // Run every 1.5 seconds
const COOLDOWN_MS = 10000; // 10s cooldown per event type
const MISSING_THRESHOLD = 2; // 2 consecutive absent checks (3s) -> FACE_MISSING
const MULTIPLE_THRESHOLD = 2; // 2 consecutive checks -> MULTIPLE_FACES
const PHONE_THRESHOLD = 2; // 2 consecutive checks -> PHONE_DETECTED

let globalCocoModel = null;
let modelLoadingPromise = null;

function loadCocoModel() {
  if (globalCocoModel) return Promise.resolve(globalCocoModel);
  if (modelLoadingPromise) return modelLoadingPromise;
  modelLoadingPromise = cocoSsd.load({ base: 'lite_mobilenet_v2' }).then(m => {
    globalCocoModel = m;
    return m;
  }).catch(err => {
    console.warn('Failed to load COCO-SSD model, using heuristic fallback:', err);
    return null;
  });
  return modelLoadingPromise;
}

function useCameraProctor(stream, onAiEvent, active) {
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const modelRef = useRef(null);
  const cooldowns = useRef({});
  const missingCount = useRef(0);
  const multipleCount = useRef(0);
  const phoneCount = useRef(0);

  const [detectionState, setDetectionState] = useState({
    faceStatus: 'ok', // 'ok' | 'missing' | 'multiple' | 'phone'
    cameraOk: true,
    lastAnalysis: null,
    analysisActive: false,
  });

  // Preload COCO-SSD neural network model
  useEffect(() => {
    loadCocoModel().then(m => {
      modelRef.current = m;
    });
  }, []);

  // Create canvas for frame processing fallback
  useEffect(() => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      canvasRef.current.width = 160;
      canvasRef.current.height = 120;
    }
  }, []);

  // Hidden video element from stream
  useEffect(() => {
    if (!stream || !active) return;
    const vid = document.createElement('video');
    vid.srcObject = stream;
    vid.muted = true;
    vid.playsInline = true;
    vid.play().catch(() => {});
    videoRef.current = vid;
    return () => {
      vid.pause();
      vid.srcObject = null;
      videoRef.current = null;
    };
  }, [stream, active]);

  const canFire = useCallback((eventType) => {
    const now = Date.now();
    const last = cooldowns.current[eventType] || 0;
    if (now - last < COOLDOWN_MS) return false;
    cooldowns.current[eventType] = now;
    return true;
  }, []);

  // Frame Analysis
  const analyzeFrame = useCallback(async () => {
    const vid = videoRef.current;
    const canvas = canvasRef.current;
    if (!vid || !canvas || vid.readyState < 2) return;

    let hasPhone = false;
    let faceCount = 1;

    // 1. AI Neural Network Detection (COCO-SSD)
    if (modelRef.current) {
      try {
        const predictions = await modelRef.current.detect(vid);
        let personCount = 0;

        for (const p of predictions) {
          if (p.class === 'cell phone' && p.score >= 0.40) {
            hasPhone = true;
          }
          if (p.class === 'person' && p.score >= 0.45) {
            personCount++;
          }
        }

        faceCount = personCount;
      } catch (err) {
        console.warn('AI detection error, using fallback:', err);
      }
    } else {
      // 2. Spatial Grid Pixel Analysis Fallback
      const width = 160;
      const height = 120;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(vid, 0, 0, width, height);

      const imgData = ctx.getImageData(0, 0, width, height);
      const data = imgData.data;
      const totalPixels = data.length / 4;

      let headZoneSkin = 0;
      let upperLeftSkin = 0;
      let upperRightSkin = 0;
      let totalLuminance = 0;

      const headMinX = Math.floor(width * 0.28);
      const headMaxX = Math.floor(width * 0.72);
      const headMinY = Math.floor(height * 0.08);
      const headMaxY = Math.floor(height * 0.58);
      const headTotal = (headMaxX - headMinX) * (headMaxY - headMinY);

      for (let p = 0; p < data.length; p += 4) {
        const pixelIdx = p / 4;
        const x = pixelIdx % width;
        const y = Math.floor(pixelIdx / width);

        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];

        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        totalLuminance += lum;

        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

        const isSkin = (
          cr >= 130 && cr <= 175 &&
          cb >= 75 && cb <= 130 &&
          r > 50 && g > 30 && b > 20 &&
          r > g && r > b
        );

        if (isSkin) {
          if (x >= headMinX && x <= headMaxX && y >= headMinY && y <= headMaxY) {
            headZoneSkin++;
          }
          if (y < height * 0.55) {
            if (x < width * 0.35) upperLeftSkin++;
            if (x > width * 0.65) upperRightSkin++;
          }
        }
      }

      const headSkinRatio = headZoneSkin / headTotal;
      const avgLum = totalLuminance / totalPixels;

      if (avgLum < 6 || headSkinRatio < 0.065) {
        faceCount = 0;
      } else if (upperLeftSkin / totalPixels > 0.12 && upperRightSkin / totalPixels > 0.12) {
        faceCount = 2;
      } else {
        faceCount = 1;
      }
    }

    const now = new Date();

    // Priority Condition A: Phone Detected (when student is present and holding a phone)
    if (faceCount > 0 && hasPhone) {
      phoneCount.current += 1;
      if (phoneCount.current >= PHONE_THRESHOLD) {
        setDetectionState(s => ({ ...s, faceStatus: 'phone', lastAnalysis: now, analysisActive: true }));
        if (canFire('PHONE_DETECTED') && onAiEvent) {
          onAiEvent('PHONE_DETECTED', 0.96);
        }
      }
    } else {
      phoneCount.current = 0;
    }

    // Condition B: Face Missing (Disappeared from camera / empty room)
    if (faceCount === 0) {
      missingCount.current += 1;
      multipleCount.current = 0;
      if (missingCount.current >= MISSING_THRESHOLD) {
        setDetectionState(s => ({ ...s, faceStatus: 'missing', lastAnalysis: now, analysisActive: true }));
        if (canFire('FACE_MISSING') && onAiEvent) {
          onAiEvent('FACE_MISSING', 0.95);
        }
      }
    }
    // Condition C: Multiple Faces (distinct 2+ people)
    else if (faceCount >= 2 && !hasPhone) {
      multipleCount.current += 1;
      missingCount.current = 0;
      if (multipleCount.current >= MULTIPLE_THRESHOLD) {
        setDetectionState(s => ({ ...s, faceStatus: 'multiple', lastAnalysis: now, analysisActive: true }));
        if (canFire('MULTIPLE_FACES') && onAiEvent) {
          onAiEvent('MULTIPLE_FACES', 0.95);
        }
      }
    }
    // Condition D: Normal Single Person Present
    else {
      missingCount.current = 0;
      multipleCount.current = 0;
      if (!hasPhone) {
        setDetectionState(s => ({ ...s, faceStatus: 'ok', lastAnalysis: now, analysisActive: true }));
      }
    }
  }, [onAiEvent, canFire]);

  // Run analysis loop
  useEffect(() => {
    if (!stream || !active) return;
    const interval = setInterval(analyzeFrame, ANALYSIS_INTERVAL);
    return () => clearInterval(interval);
  }, [stream, active, analyzeFrame]);

  // Track stream health
  useEffect(() => {
    if (!stream || !active) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    const onEnded = () => {
      setDetectionState(s => ({ ...s, cameraOk: false, faceStatus: 'missing' }));
      if (onAiEvent) onAiEvent('CAMERA_DISABLED', 1.0);
    };

    videoTrack.addEventListener('ended', onEnded);
    return () => videoTrack.removeEventListener('ended', onEnded);
  }, [stream, active, onAiEvent]);

  return detectionState;
}

function CameraWarningOverlay({ violations, maxViolations }) {
  return (
    <div className="camera-warning-overlay">
      <div className="camera-warning-content">
        <span className="camera-warning-icon">🚫</span>
        <h2>Camera Disconnected</h2>
        <p>
          Your camera has been disabled or disconnected. This is a proctoring violation.
          Please re-enable your camera immediately to continue the exam.
        </p>
        <div className="violation-counter-badge">
          ⚠️ Violations: {violations} / {maxViolations}
        </div>
      </div>
    </div>
  );
}

function CodeEditor({ value, onChange, language = 'python', starterCode, disabled }) {
  const textareaRef = useRef(null);

  const lines = (value || '').split('\n');
  const lineCount = Math.max(lines.length, 6);

  function handleKeyDown(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.target.selectionStart;
      const end = e.target.selectionEnd;
      const val = e.target.value;
      const newVal = val.substring(0, start) + '    ' + val.substring(end);
      onChange(newVal);
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 4;
        }
      }, 0);
    }
  }

  function handleReset() {
    if (confirm('Reset code to starter template?')) {
      onChange(starterCode || '');
    }
  }

  const langLabel = {
    python: '🐍 Python 3',
    javascript: '⚡ JavaScript',
    java: '☕ Java',
    cpp: '⚙️ C / C++',
    sql: '🗄️ SQL',
    plain_text: '📝 Written / Descriptive',
  }[language] || `💻 ${String(language).toUpperCase()}`;

  return (
    <div className="code-editor-wrapper">
      <div className="code-editor-header">
        <span className="code-editor-lang-pill">{langLabel}</span>
        <div className="code-editor-stats">
          <span>{lines.length} lines</span>
          <span>·</span>
          <span>{(value || '').length} chars</span>
          {starterCode && (
            <button
              type="button"
              className="code-reset-btn"
              onClick={handleReset}
              disabled={disabled}
              title="Reset code to starter template"
            >
              ↺ Reset
            </button>
          )}
        </div>
      </div>
      <div className="code-editor-body">
        <div className="code-line-numbers" aria-hidden="true">
          {Array.from({ length: lineCount }).map((_, idx) => (
            <div key={idx} className="code-line-num">{idx + 1}</div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          className="code-textarea"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your code or answer here..."
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>
    </div>
  );
}

function Exam({ attempt, onFinish }) {
  const [data, setData] = useState(null);
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState({});
  const [left, setLeft] = useState(0);
  const [violations, setViolations] = useState(0);
  const [verifiedPw, setVerifiedPw] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [stream, setStream] = useState(null);
  const [msg, setMsg] = useState('');
  const [maxViol, setMaxViol] = useState(2);
  const submitted = useRef(false);

  // Fetch Attempt
  useEffect(() => {
    api(`/attempts/${attempt.attempt_id || attempt.id}`)
      .then((d) => {
        setData(d);
        setAnswers(d.answers || {});
        setMaxViol(d.exam.max_violations || 2);

        // Compute exact remaining seconds based on server started_at
        const startedTime = new Date(d.started_at).getTime();
        const durationMs = d.exam.duration_minutes * 60 * 1000;
        const now = Date.now();
        const elapsedSec = Math.floor((now - startedTime) / 1000);
        const remainingSec = Math.max(0, d.exam.duration_minutes * 60 - elapsedSec);
        setLeft(remainingSec);
      })
      .catch((e) => setMsg(e.message));
  }, [attempt]);

  // Clean up camera on unmount
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [stream]);

  // Monitor video track end event -> automatically log CAMERA_DISABLED violation
  useEffect(() => {
    if (!stream) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    const onTrackEnded = () => {
      recordViolation('CAMERA_DISABLED');
      setMsg('🚫 Camera stream ended — recorded as a proctoring violation.');
    };

    videoTrack.addEventListener('ended', onTrackEnded);
    return () => videoTrack.removeEventListener('ended', onTrackEnded);
  }, [stream]);

  async function reenableCamera() {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true,
      });
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
      setStream(newStream);
      setCameraReady(true);
      showMsg && setMsg ? setMsg('✅ Camera turned on successfully!') : null;
    } catch (err) {
      setMsg('❌ Failed to access camera. Please allow camera permissions in your browser.');
    }
  }

  async function toggleCamera() {
    if (!stream) {
      await reenableCamera();
      return;
    }
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && videoTrack.readyState === 'live' && videoTrack.enabled) {
      videoTrack.stop();
      videoTrack.enabled = false;
      recordViolation('CAMERA_DISABLED');
      setMsg('⚠️ Camera turned off — recorded as a proctoring violation.');
    } else {
      await reenableCamera();
    }
  }

  // Violation Event Listeners — Complete Anti-Cheating Suite
  useEffect(() => {
    if (!cameraReady) return;

    // 1. Tab switch / Window hidden
    const onVis = () => {
      if (document.hidden) recordViolation('TAB_SWITCH');
    };

    // 2. Fullscreen exit
    const onFs = () => {
      if (!document.fullscreenElement) recordViolation('FULLSCREEN_EXIT');
    };

    // 3. Window blur / Alt+Tab / App Switch
    const onBlur = () => {
      recordViolation('WINDOW_BLUR');
    };

    // 4. Copy, Paste, Cut prevention
    const onCopyPasteCut = (e) => {
      e.preventDefault();
      recordViolation('COPY_PASTE_ATTEMPT');
    };

    // 5. Context menu (Right-click) prevention
    const onContextMenu = (e) => {
      e.preventDefault();
      recordViolation('CONTEXT_MENU_ATTEMPT');
    };

    // 6. Developer Tools & Shortcut Keys (F12, Inspect, Alt+Tab, Cmd+C, Cmd+V, Ctrl+U)
    const onKeyDown = (e) => {
      if (
        e.key === 'F12' ||
        (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) ||
        (e.metaKey && e.altKey && (e.key === 'i' || e.key === 'I' || e.key === 'j' || e.key === 'c')) ||
        (e.ctrlKey && (e.key === 'u' || e.key === 'U' || e.key === 'c' || e.key === 'v')) ||
        (e.metaKey && (e.key === 'c' || e.key === 'v'))
      ) {
        e.preventDefault();
        recordViolation('DEVTOOLS_ATTEMPT');
      }
    };

    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('blur', onBlur);
    document.addEventListener('copy', onCopyPasteCut);
    document.addEventListener('paste', onCopyPasteCut);
    document.addEventListener('cut', onCopyPasteCut);
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('copy', onCopyPasteCut);
      document.removeEventListener('paste', onCopyPasteCut);
      document.removeEventListener('cut', onCopyPasteCut);
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [cameraReady]);

  // Exam Countdown Timer
  useEffect(() => {
    if (!cameraReady || left <= 0) return;
    const t = setInterval(() => {
      setLeft((x) => {
        if (x <= 1) {
          submitExam();
          return 0;
        }
        return x - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [cameraReady, left]);

  async function recordViolation(type) {
    if (submitted.current) return;
    try {
      const d = await api(`/attempts/${data.id}/violations`, {
        method: 'POST',
        body: JSON.stringify({ type, metadata: { visibility: document.visibilityState } }),
      });
      setViolations(d.violation_count);
      if (d.auto_submitted) {
        submitted.current = true;
        setMsg(`Exam auto-submitted due to excessive violations (${type})`);
        onFinish('auto_submitted');
      }
    } catch (e) {
      setMsg(e.message);
    }
  }

  // Callback for the camera proctoring hook to report AI events
  const handleAiEvent = useCallback(async (eventType, confidence) => {
    if (submitted.current || !data) return;
    try {
      const d = await api(`/attempts/${data.id}/ai-event`, {
        method: 'POST',
        body: JSON.stringify({ event_type: eventType, confidence, metadata: { timestamp: new Date().toISOString() } }),
      });
      if (d.violation_logged) {
        setViolations(d.violation_count);
      }
      if (d.auto_submitted) {
        submitted.current = true;
        setMsg(`Exam auto-submitted by AI Proctoring (${eventType})`);
        onFinish('auto_submitted');
      }
    } catch (e) {
      setMsg(e.message);
    }
  }, [data, onFinish]);

  // Camera proctoring hook — runs face & phone detection
  const detectionState = useCameraProctor(stream, handleAiEvent, cameraReady && !submitted.current);
  // Audio proctoring hook — monitors speech and background noise violations
  useAudioProctor(stream, handleAiEvent, cameraReady && !submitted.current);

  // Warn before closing tab during exam
  useEffect(() => {
    if (!cameraReady) return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = 'You have an exam in progress. Are you sure you want to leave?';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [cameraReady]);

  const autoSaveTimerRef = useRef(null);

  function handleTextAnswerChange(qId, val) {
    const newAnswers = { ...answers, [String(qId)]: val };
    setAnswers(newAnswers);
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      try {
        await api(`/attempts/${data.id}/answers`, {
          method: 'POST',
          body: JSON.stringify({ question_id: qId, text_answer: val }),
        });
      } catch (e) {
        console.warn('Auto-save answer failed:', e);
      }
    }, 600);
  }

  async function selectOption(qId, optionIdx) {
    const newAnswers = { ...answers, [String(qId)]: optionIdx };
    setAnswers(newAnswers);
    try {
      await api(`/attempts/${data.id}/answers`, {
        method: 'POST',
        body: JSON.stringify({ question_id: qId, option_index: optionIdx }),
      });
    } catch (e) {
      setMsg(e.message);
    }
  }

  async function submitExam() {
    if (submitted.current) return;
    submitted.current = true;
    try {
      const d = await api(`/attempts/${data.id}/submit`, { method: 'POST' });
      onFinish(d.status);
    } catch (e) {
      setMsg(e.message);
    }
  }

  if (!data) return <div className="center"><div className="spinner">Loading exam...</div></div>;

  // Step 1: Re-authenticate password
  if (!verifiedPw) {
    return (
      <PasswordReauthModal
        onVerified={() => setVerifiedPw(true)}
        onCancel={() => onFinish('cancel')}
      />
    );
  }

  // Step 2: System Check / Camera Gate
  if (!cameraReady) {
    return (
      <CameraCheck
        onReady={async (mediaStream) => {
          setStream(mediaStream);
          setCameraReady(true);
          try {
            const startRes = await api(`/attempts/${data.id}/start-timer`, { method: 'POST' });
            setLeft((startRes.duration_minutes || data.exam.duration_minutes) * 60);
          } catch (e) {
            console.warn('Failed to start timer:', e);
          }
          try {
            await document.documentElement.requestFullscreen?.();
          } catch (e) {
            console.warn('Fullscreen ignored:', e);
          }
        }}
        onCancel={() => onFinish('cancel')}
      />
    );
  }

  const q = data.questions[i];
  const selectedOpt = answers[String(q.id)];

  return (
    <div className="exam-container">
      <header className="exam-header">
        <div className="header-title">
          <span className="exam-name">{data.exam.title}</span>
          <span className="badge-chip info">Question {i + 1} of {data.questions.length}</span>
        </div>
        <div className="header-meta">
          <ThemeToggle />
          <button
            type="button"
            className="camera-toggle-btn"
            onClick={toggleCamera}
            style={{
              backgroundColor: detectionState.cameraOk ? 'rgba(16, 185, 129, 0.15)' : 'rgba(220, 38, 38, 0.15)',
              color: detectionState.cameraOk ? '#059669' : '#dc2626',
              border: `1px solid ${detectionState.cameraOk ? '#10b981' : '#ef4444'}`,
              padding: '6px 12px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: '600',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
            title={detectionState.cameraOk ? 'Turn off camera (logs violation)' : 'Turn on camera'}
          >
            {detectionState.cameraOk ? '🎥 Camera ON' : '🔴 Camera OFF (Violation)'}
          </button>
          <div className="timer-badge">
            ⏱️ {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </div>
          <div className={`violation-badge ${violations > 0 ? 'warning' : ''}`}>
            ⚠️ Violations: {violations} / {data.exam.max_violations}
          </div>
        </div>
      </header>

      <main className="exam-layout">
        <section className="question-card glass-card">
          {!detectionState.cameraOk && (
            <div
              className="camera-disabled-alert-banner"
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid #ef4444',
                color: '#fca5a5',
                padding: '12px 16px',
                borderRadius: '8px',
                marginBottom: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
              }}
            >
              <div>
                <strong>⚠️ Camera Currently OFF / Disabled</strong>
                <p style={{ margin: '4px 0 0 0', fontSize: '13px', opacity: 0.9 }}>
                  Disabling the camera is recorded as a proctoring violation. Click below to turn it back on.
                </p>
              </div>
              <button
                type="button"
                onClick={reenableCamera}
                style={{
                  backgroundColor: '#2563eb',
                  color: '#fff',
                  border: 'none',
                  padding: '8px 14px',
                  borderRadius: '6px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                🎥 Turn On Camera
              </button>
            </div>
          )}
          <div className="question-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ margin: 0 }}>Question {i + 1}</h3>
              {q.type === 'code' ? (
                <span className="badge-chip info" style={{ fontSize: '11px' }}>💻 Coding</span>
              ) : q.type === 'text' ? (
                <span className="badge-chip info" style={{ fontSize: '11px' }}>📝 Written</span>
              ) : (
                <span className="badge-chip secondary" style={{ fontSize: '11px' }}>🔘 Multiple Choice</span>
              )}
            </div>
            <span className="marks-badge">{q.marks} Mark{q.marks > 1 ? 's' : ''}</span>
          </div>
          <p className="question-text">{q.text}</p>

          {q.type === 'code' || q.type === 'text' ? (
            <div className="code-question-container">
              <CodeEditor
                value={answers[String(q.id)] !== undefined ? answers[String(q.id)] : (q.starter_code || '')}
                onChange={(val) => handleTextAnswerChange(q.id, val)}
                language={q.language || 'python'}
                starterCode={q.starter_code}
              />
            </div>
          ) : (
            <div className="options-list">
              {(q.options || []).map((optionText, n) => (
                <button
                  key={n}
                  type="button"
                  className={`option-btn ${selectedOpt === n ? 'selected' : ''}`}
                  onClick={() => selectOption(q.id, n)}
                >
                  <span className="option-letter">{String.fromCharCode(65 + n)}</span>
                  <span className="option-content">{optionText}</span>
                </button>
              ))}
            </div>
          )}

          <div className="nav-bar">
            <button
              type="button"
              className="secondary-btn"
              disabled={i === 0}
              onClick={() => setI(i - 1)}
            >
              Previous
            </button>
            {i < data.questions.length - 1 ? (
              <button type="button" className="primary-btn" onClick={() => setI(i + 1)}>
                Next Question
              </button>
            ) : (
              <button type="button" className="primary-btn success" onClick={submitExam}>
                Submit Exam
              </button>
            )}
          </div>
        </section>

        <aside className="proctor-sidebar glass-card">
          <h4>Proctoring Monitor</h4>
          <video
            ref={(el) => {
              if (el && stream) el.srcObject = stream;
            }}
            autoPlay
            muted
            playsInline
            className="proctor-video"
          />
          <div className="proctor-status">
            <span className="live-indicator">● LIVE</span> Full-Screen & Camera Monitored
          </div>
          <div className="proctor-controls" style={{ marginTop: '8px', marginBottom: '12px' }}>
            <button
              type="button"
              onClick={toggleCamera}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: '13px',
                fontWeight: 'bold',
                borderRadius: '6px',
                border: 'none',
                backgroundColor: detectionState.cameraOk ? '#dc2626' : '#2563eb',
                color: '#ffffff',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
              }}
            >
              {detectionState.cameraOk ? '🔴 Turn Off Camera (Logs Violation)' : '🎥 Turn On Camera'}
            </button>
          </div>

          <div className="palette-section">
            <h5>Question Palette</h5>
            <div className="palette-grid">
              {data.questions.map((item, idx) => {
                const ans = answers[String(item.id)];
                const isAnswered = ans !== undefined && ans !== '' && ans !== null;
                const isCurrent = idx === i;
                return (
                  <button
                    key={item.id}
                    className={`palette-btn ${isAnswered ? 'answered' : ''} ${isCurrent ? 'current' : ''}`}
                    onClick={() => setI(idx)}
                  >
                    {idx + 1}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="ai-proctor-dashboard">
            <div className="ai-proctor-header">
              <span className={`analysis-pulse ${
                !detectionState.cameraOk ? 'danger' :
                detectionState.faceStatus === 'missing' || detectionState.faceStatus === 'multiple' ? 'warning' : ''
              }`} />
              <h5>AI Proctoring — Live</h5>
            </div>
            <div className="detection-status-list">
              <div className={`detection-status-item ${
                detectionState.cameraOk ? 'ok' : 'violation'
              }`}>
                <span className="status-icon">{detectionState.cameraOk ? '📹' : '🚫'}</span>
                <span className="status-text">
                  {detectionState.cameraOk ? 'Camera active' : 'Camera disconnected!'}
                </span>
              </div>
              <div className={`detection-status-item ${
                detectionState.faceStatus === 'ok' ? 'ok' :
                detectionState.faceStatus === 'waiting' ? '' : 'violation'
              }`}>
                <span className="status-icon">
                  {detectionState.faceStatus === 'ok' ? '✓' :
                   detectionState.faceStatus === 'missing' ? '❌' :
                   detectionState.faceStatus === 'phone' ? '📱' :
                   detectionState.faceStatus === 'multiple' ? '👥' : '⏳'}
                </span>
                <span className="status-text">
                  {detectionState.faceStatus === 'ok' ? 'Face detected' :
                   detectionState.faceStatus === 'missing' ? 'No face detected / Absent!' :
                   detectionState.faceStatus === 'phone' ? 'Phone / Device detected!' :
                   detectionState.faceStatus === 'multiple' ? 'Multiple faces detected!' : 'Initializing...'}
                </span>
              </div>
            </div>
            {detectionState.lastAnalysis && (
              <div className="detection-timestamp">
                Last scan: {detectionState.lastAnalysis.toLocaleTimeString()}
              </div>
            )}
          </div>
        </aside>
      </main>

      {msg && <div className="toast-notification">{msg}</div>}
      {!detectionState.cameraOk && (
        <CameraWarningOverlay violations={violations} maxViolations={maxViol} />
      )}
    </div>
  );
}

function RoughWork({ attemptId, onDone }) {
  const [file, setFile] = useState(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  async function send(skip) {
    setMsg('');
    setLoading(true);
    try {
      if (skip) {
        await api(`/attempts/${attemptId}/rough-work?skipped=true`, { method: 'POST' });
      } else {
        if (!file) throw new Error('Please select a file to upload or click Skip.');
        const fd = new FormData();
        fd.append('file', file);
        const r = await fetch(`${API}/attempts/${attemptId}/rough-work`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token()}` },
          body: fd,
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || 'Upload failed');
      }
      onDone();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="center">
      <div className="card glass-card">
        <div className="badge-chip success">✓ Exam Submitted Successfully</div>
        <h2>Rough Work Upload</h2>
        <p className="subtitle">
          If you solved calculations on paper, you can upload a scan (PDF, JPG, PNG) for reviewer verification.
        </p>

        <div className="file-dropzone">
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            id="file-input"
            onChange={(e) => setFile(e.target.files?.[0])}
          />
          <label htmlFor="file-input" className="file-label">
            📁 {file ? file.name : 'Choose PDF, JPG or PNG file'}
          </label>
        </div>

        {msg && <div className="error-badge">{msg}</div>}

        <div className="btn-group">
          <button
            type="button"
            className="primary-btn"
            disabled={!file || loading}
            onClick={() => send(false)}
          >
            {loading ? 'Uploading...' : 'Upload Rough Work'}
          </button>
          <button
            type="button"
            className="secondary-btn"
            disabled={loading}
            onClick={() => send(true)}
          >
            Skip Rough Work
          </button>
        </div>
      </div>
    </div>
  );
}

function AttemptInspectModal({ attempt, onClose, onGraded }) {
  const [grades, setGrades] = useState(attempt.manual_grades || {});
  const [feedback, setFeedback] = useState(attempt.feedback || '');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const questions = attempt.exam?.questions || [];

  function handleGradeChange(qid, val) {
    const num = val === '' ? '' : Number(val);
    setGrades((prev) => ({
      ...prev,
      [qid]: num,
    }));
  }

  async function handleSubmitGrades(e) {
    e.preventDefault();
    setLoading(true);
    setMsg('');
    try {
      const cleanGrades = {};
      Object.entries(grades).forEach(([k, v]) => {
        if (v !== '' && !isNaN(Number(v))) {
          cleanGrades[k] = Number(v);
        }
      });
      const res = await api(`/admin/attempts/${attempt.id}/grade`, {
        method: 'POST',
        body: JSON.stringify({
          grades: cleanGrades,
          feedback,
        }),
      });
      setMsg('✅ Grades saved successfully!');
      if (onGraded) onGraded(res);
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err) {
      setMsg(`❌ ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Calculate current projected score
  const totalScore = questions.reduce((acc, q) => {
    const qid = String(q.id);
    if (grades[qid] !== undefined && grades[qid] !== '') {
      return acc + Number(grades[qid]);
    }
    if (q.type === 'mcq' || !q.type) {
      const stuAns = attempt.answers?.[qid];
      if (stuAns !== undefined && Number(stuAns) === Number(q.correct_answer)) {
        return acc + Number(q.marks || 1);
      }
    }
    return acc;
  }, 0);

  return (
    <div className="auth-modal-overlay" onClick={onClose}>
      <div className="glass-card inspect-modal" onClick={(e) => e.stopPropagation()}>
        <div className="inspect-modal-header">
          <div>
            <h2>📝 Inspect & Grade Submission</h2>
            <p className="subtitle">
              Student: <strong>{attempt.student?.name}</strong> ({attempt.student?.email}) · Exam: <strong>{attempt.exam?.title}</strong>
            </p>
          </div>
          <div className="inspect-score-summary">
            <span className="inspect-score-label">Attempt Score</span>
            <span className="inspect-score-val">{totalScore} / {attempt.exam?.total_marks || 0}</span>
          </div>
        </div>

        {msg && <div className="info-msg" style={{ marginBottom: '16px' }}>{msg}</div>}

        <form onSubmit={handleSubmitGrades} className="inspect-form">
          <div className="inspect-questions-list">
            {questions.map((q, idx) => {
              const qid = String(q.id);
              const isMcq = q.type === 'mcq' || !q.type;
              const stuAns = attempt.answers?.[qid];
              const awarded = grades[qid] !== undefined ? grades[qid] : (
                isMcq ? (stuAns !== undefined && Number(stuAns) === Number(q.correct_answer) ? q.marks : 0) : ''
              );

              return (
                <div key={qid} className="inspect-q-card glass-card">
                  <div className="inspect-q-header">
                    <span className="badge-chip info">Q{idx + 1} · {q.type === 'code' ? '💻 Coding' : q.type === 'text' ? '📝 Written' : '🔘 MCQ'}</span>
                    <span className="marks-badge">{q.marks} Mark{q.marks > 1 ? 's' : ''}</span>
                  </div>
                  <p className="inspect-q-text">{q.text}</p>

                  {isMcq ? (
                    <div className="inspect-mcq-review">
                      <div className="inspect-options-grid">
                        {(q.options || []).map((opt, optIdx) => {
                          const isSelected = stuAns !== undefined && Number(stuAns) === optIdx;
                          const isCorrect = Number(q.correct_answer) === optIdx;
                          let cls = 'inspect-opt';
                          if (isCorrect) cls += ' opt-correct';
                          if (isSelected && !isCorrect) cls += ' opt-incorrect';
                          if (isSelected) cls += ' opt-selected';

                          return (
                            <div key={optIdx} className={cls}>
                              <span className="opt-letter">{String.fromCharCode(65 + optIdx)}</span>
                              <span className="opt-text">{opt}</span>
                              {isSelected && <span className="opt-tag stu">Candidate Choice</span>}
                              {isCorrect && <span className="opt-tag ans">Correct</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="inspect-code-review">
                      {q.language && <span className="code-lang-tag">Language: {q.language}</span>}
                      <label className="inspect-sublabel">Student's Submitted Answer / Code:</label>
                      {stuAns ? (
                        <pre className="inspect-code-block">
                          <code>{stuAns}</code>
                        </pre>
                      ) : (
                        <div className="inspect-no-answer">⚠️ No code or answer submitted for this question.</div>
                      )}

                      {q.sample_solution && (
                        <details className="inspect-ref-solution">
                          <summary>🔍 View Reference Solution / Criteria</summary>
                          <pre className="inspect-ref-code"><code>{q.sample_solution}</code></pre>
                        </details>
                      )}

                      <div className="inspect-grade-input-group">
                        <label>Award Marks (0 to {q.marks}):</label>
                        <input
                          type="number"
                          min="0"
                          max={q.marks}
                          value={awarded}
                          onChange={(e) => handleGradeChange(qid, e.target.value)}
                          placeholder={`0 - ${q.marks}`}
                          className="inspect-marks-input"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="form-group inspect-feedback-group">
            <label>Instructor Feedback / Comments (optional)</label>
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Provide feedback to the student regarding their code, methodology, or written answers..."
              rows={3}
            />
          </div>

          <div className="inspect-modal-actions">
            <button type="button" className="secondary-btn" onClick={onClose}>
              Close
            </button>
            <button type="submit" className="primary-btn success" disabled={loading}>
              {loading ? 'Saving...' : '💾 Save Grades & Recalculate Total'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AdminDashboard({ user, onLogout, onVerifyClick }) {
  const [tab, setTab] = useState('attempts');
  const [exams, setExams] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState('info'); // 'info' | 'error'

  // New Exam Form
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(30);
  const [maxViolations, setMaxViolations] = useState(2);

  // New Question Form
  const [selectedExamId, setSelectedExamId] = useState('');
  const [qType, setQType] = useState('mcq'); // 'mcq' | 'code' | 'text'
  const [qText, setQText] = useState('');
  const [qLang, setQLang] = useState('python');
  const [qStarter, setQStarter] = useState('');
  const [qSample, setQSample] = useState('');
  const [opt0, setOpt0] = useState('');
  const [opt1, setOpt1] = useState('');
  const [opt2, setOpt2] = useState('');
  const [opt3, setOpt3] = useState('');
  const [correct, setCorrect] = useState(0);
  const [marks, setMarks] = useState(1);
  const [inspectingAttempt, setInspectingAttempt] = useState(null);

  // Subject Form
  const [subjectName, setSubjectName] = useState('');
  const [subjectDesc, setSubjectDesc] = useState('');
  const [subjectLoading, setSubjectLoading] = useState(false);
  const [deletingSubjectId, setDeletingSubjectId] = useState(null);
  const [deletingAttemptId, setDeletingAttemptId] = useState(null);

  // Attempt search/filter
  const [attemptSearch, setAttemptSearch] = useState('');

  // ── AI Generator wizard ──────────────────────────────────────────────────
  const [aiStep, setAiStep] = useState(1);          // 1 | 2 | 3
  const [aiFile, setAiFile] = useState(null);
  const [aiNumQ, setAiNumQ] = useState(10);
  const [aiSubjectId, setAiSubjectId] = useState('');  // '' = none, 'custom' = freetext, else subject id string
  const [aiHint, setAiHint] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiQuestions, setAiQuestions] = useState([]); // raw from API
  const [aiSelected, setAiSelected] = useState({});   // {idx: true/false}
  const [aiEditing, setAiEditing] = useState({});     // {idx: {text,options,correct_answer,marks}}
  const [aiExamTitle, setAiExamTitle] = useState('');
  const [aiDuration, setAiDuration] = useState(60);
  const [aiMaxViol, setAiMaxViol] = useState(2);
  const [aiPublishing, setAiPublishing] = useState(false);
  const [aiSuccess, setAiSuccess] = useState(null);   // {exam_id, title, question_count}
  const aiFileRef = useRef(null);

  useEffect(() => {
    loadData();
  }, [tab]);

  function showMsg(text, type = 'info') {
    setMsg(text);
    setMsgType(type);
    setTimeout(() => setMsg(''), 4000);
  }

  async function loadData() {
    setMsg('');
    try {
      if (tab === 'exams') {
        const d = await api('/admin/exams');
        setExams(d);
        if (d.length > 0 && !selectedExamId) setSelectedExamId(String(d[0].id));
      } else if (tab === 'subjects') {
        const d = await api('/admin/subjects');
        setSubjects(d);
      } else if (tab === 'ai') {
        // Load subjects so the subject picker is populated
        const d = await api('/admin/subjects');
        setSubjects(d);
      } else {
        const d = await api('/admin/attempts');
        setAttempts(d);
      }
    } catch (e) {
      setMsg(e.message);
      setMsgType('error');
    }
  }

  async function handleCreateExam(e) {
    e.preventDefault();
    setMsg('');
    try {
      await api('/admin/exams', {
        method: 'POST',
        body: JSON.stringify({
          title,
          duration_minutes: Number(duration),
          max_violations: Number(maxViolations),
          require_camera: true,
          require_microphone: true,
        }),
      });
      setTitle('');
      showMsg('✅ Exam created successfully!');
      loadData();
    } catch (err) {
      showMsg(err.message, 'error');
    }
  }

  async function handleAddQuestion(e) {
    e.preventDefault();
    if (!selectedExamId) return;
    setMsg('');
    try {
      const payload = {
        type: qType,
        text: qText,
        marks: Number(marks),
      };
      if (qType === 'mcq') {
        payload.options = [opt0, opt1, opt2, opt3].filter(Boolean);
        payload.correct_answer = Number(correct);
      } else {
        payload.language = qLang;
        payload.starter_code = qStarter;
        payload.sample_solution = qSample;
      }
      await api(`/admin/exams/${selectedExamId}/questions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setQText('');
      setOpt0('');
      setOpt1('');
      setOpt2('');
      setOpt3('');
      setQStarter('');
      setQSample('');
      showMsg('✅ Question added successfully!');
      loadData();
    } catch (err) {
      showMsg(err.message, 'error');
    }
  }

  async function downloadRoughWork(roughWorkId, filename) {
    try {
      const res = await fetch(`${API}/admin/rough-work/${roughWorkId}/download`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'rough-work';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setMsg(e.message);
    }
  }

  async function deleteExam(examId, examTitle) {
    if (!confirm(`Delete exam "${examTitle}"? This will also delete all attempts and violations for this exam.`)) return;
    try {
      await api(`/admin/exams/${examId}`, { method: 'DELETE' });
      showMsg(`🗑️ Exam "${examTitle}" deleted.`);
      setSelectedExamId('');
      loadData();
    } catch (e) {
      showMsg(e.message, 'error');
    }
  }

  async function deleteAttempt(attemptId) {
    if (!confirm(`Delete attempt #${attemptId}? This removes all violations and uploaded files for this attempt.`)) return;
    setDeletingAttemptId(attemptId);
    try {
      await api(`/admin/attempts/${attemptId}`, { method: 'DELETE' });
      setAttempts((prev) => prev.filter((a) => a.id !== attemptId));
      showMsg(`🗑️ Attempt #${attemptId} deleted.`);
    } catch (e) {
      showMsg(e.message, 'error');
    } finally {
      setDeletingAttemptId(null);
    }
  }

  async function grantReattempt(attemptId, studentName, examTitle) {
    if (!confirm(`Grant an additional exam attempt to ${studentName} for "${examTitle}"?`)) return;
    setDeletingAttemptId(attemptId);
    try {
      const res = await api(`/admin/attempts/${attemptId}/grant-reattempt`, { method: 'POST' });
      setAttempts((prev) => prev.filter((a) => a.id !== attemptId));
      showMsg(`🔄 ${res.message || `Granted re-attempt for ${studentName}`}`);
    } catch (e) {
      showMsg(e.message, 'error');
    } finally {
      setDeletingAttemptId(null);
    }
  }

  async function clearAllAttempts() {
    if (!confirm(`Delete ALL ${attempts.length} attempt records? This cannot be undone.`)) return;
    try {
      for (const a of attempts) {
        await api(`/admin/attempts/${a.id}`, { method: 'DELETE' });
      }
      setAttempts([]);
      showMsg('🗑️ All attempt records cleared.');
    } catch (e) {
      showMsg(e.message, 'error');
      loadData();
    }
  }

  async function handleCreateSubject(e) {
    e.preventDefault();
    if (!subjectName.trim()) return;
    setSubjectLoading(true);
    try {
      await api('/admin/subjects', {
        method: 'POST',
        body: JSON.stringify({ name: subjectName.trim(), description: subjectDesc.trim() || null }),
      });
      setSubjectName('');
      setSubjectDesc('');
      showMsg('✅ Subject created successfully!');
      loadData();
    } catch (err) {
      showMsg(err.message, 'error');
    } finally {
      setSubjectLoading(false);
    }
  }

  async function deleteSubject(subjectId, subjectName) {
    if (!confirm(`Delete subject "${subjectName}"?`)) return;
    setDeletingSubjectId(subjectId);
    try {
      await api(`/admin/subjects/${subjectId}`, { method: 'DELETE' });
      setSubjects((prev) => prev.filter((s) => s.id !== subjectId));
      showMsg(`🗑️ Subject "${subjectName}" deleted.`);
    } catch (e) {
      showMsg(e.message, 'error');
    } finally {
      setDeletingSubjectId(null);
    }
  }

  // ── AI Generator helpers ─────────────────────────────────────────────────
  async function handleAnalyzeSyllabus(e) {
    e.preventDefault();
    if (!aiFile) return;
    setAiLoading(true);
    setAiError('');
    try {
      // Build a rich subject context string for Gemini
      let subjectContext = '';
      if (aiSubjectId && aiSubjectId !== 'custom') {
        const sub = subjects.find((s) => String(s.id) === aiSubjectId);
        if (sub) {
          subjectContext = sub.description
            ? `Subject: ${sub.name} — ${sub.description}`
            : `Subject: ${sub.name}`;
        }
      } else if (aiSubjectId === 'custom') {
        subjectContext = aiHint.trim();
      }

      const fd = new FormData();
      fd.append('file', aiFile);
      fd.append('num_questions', String(aiNumQ));
      fd.append('subject_hint', subjectContext);
      const res = await fetch(`${API}/admin/ai/analyze-syllabus`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}` },
        body: fd,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.detail || 'Analysis failed');
      // Initialise all as selected, no edits
      const sel = {};
      d.questions.forEach((_, i) => { sel[i] = true; });
      setAiQuestions(d.questions);
      setAiSelected(sel);
      setAiEditing({});
      // Pre-fill exam title from subject name
      if (aiSubjectId && aiSubjectId !== 'custom') {
        const sub = subjects.find((s) => String(s.id) === aiSubjectId);
        if (sub) setAiExamTitle(`${sub.name} Exam`);
      } else {
        setAiExamTitle('');
      }
      setAiStep(2);
    } catch (err) {
      setAiError(err.message);
    } finally {
      setAiLoading(false);
    }
  }

  function aiToggleAll(val) {
    const sel = {};
    aiQuestions.forEach((_, i) => { sel[i] = val; });
    setAiSelected(sel);
  }

  function aiGetQuestion(i) {
    return aiEditing[i] || aiQuestions[i];
  }

  function aiUpdateEdit(i, field, value) {
    setAiEditing(prev => ({
      ...prev,
      [i]: { ...aiGetQuestion(i), [field]: value },
    }));
  }

  function aiUpdateOption(i, optIdx, value) {
    const q = aiGetQuestion(i);
    const opts = [...q.options];
    opts[optIdx] = value;
    aiUpdateEdit(i, 'options', opts);
  }

  async function handlePublishExam(e) {
    e.preventDefault();
    const selected = aiQuestions
      .map((_, i) => aiGetQuestion(i))
      .filter((_, i) => aiSelected[i]);
    if (selected.length === 0) {
      setAiError('Select at least one question.');
      return;
    }
    setAiPublishing(true);
    setAiError('');
    try {
      const d = await api('/admin/ai/create-exam-from-questions', {
        method: 'POST',
        body: JSON.stringify({
          title: aiExamTitle,
          duration_minutes: Number(aiDuration),
          max_violations: Number(aiMaxViol),
          require_camera: true,
          require_microphone: true,
          questions: selected,
        }),
      });
      setAiSuccess(d);
      setAiStep(3);
    } catch (err) {
      setAiError(err.message);
    } finally {
      setAiPublishing(false);
    }
  }

  function resetAiWizard() {
    setAiStep(1);
    setAiFile(null);
    setAiNumQ(10);
    setAiHint('');
    setAiLoading(false);
    setAiError('');
    setAiQuestions([]);
    setAiSubjectId('');
    setAiSelected({});
    setAiEditing({});
    setAiExamTitle('');
    setAiDuration(60);
    setAiMaxViol(2);
    setAiSuccess(null);
    if (aiFileRef.current) aiFileRef.current.value = '';
  }

  return (
    <div className="admin-container">
      <header className="admin-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ margin: 0 }}>⚙️ Administrator Portal</h1>
            {user.isAccountVerified ? (
              <span className="verification-badge-verified">✓ Verified</span>
            ) : (
              <span className="verification-badge-unverified" style={{ cursor: 'pointer' }} onClick={onVerifyClick} title="Click to verify email">
                ⚠️ Unverified (Click to verify)
              </span>
            )}
          </div>
          <p style={{ margin: '4px 0 0 0' }}>Logged in as {user.name} ({user.email})</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <ThemeToggle />
          <button onClick={onLogout} className="secondary-btn">
            Logout
          </button>
        </div>
      </header>

      {!user.isAccountVerified && (
        <div className="verification-banner">
          <div className="verification-banner-content">
            <span style={{ fontSize: '18px' }}>⚠️</span>
            <div>
              <strong>Email Verification Pending:</strong> Please verify your email to ensure full account protection and recovery options.
            </div>
          </div>
          <button type="button" onClick={onVerifyClick} className="primary-btn" style={{ padding: '6px 14px', fontSize: '12.5px' }}>
            Verify Email
          </button>
        </div>
      )}

      <div className="tab-bar">
        <button
          className={`tab-btn ${tab === 'attempts' ? 'active' : ''}`}
          onClick={() => setTab('attempts')}
        >
          📊 Student Attempts
        </button>
        <button
          className={`tab-btn ${tab === 'exams' ? 'active' : ''}`}
          onClick={() => setTab('exams')}
        >
          📝 Exams &amp; Questions
        </button>
        <button
          className={`tab-btn ${tab === 'subjects' ? 'active' : ''}`}
          onClick={() => setTab('subjects')}
        >
          📚 Subjects
        </button>
        <button
          className={`tab-btn ai-tab-btn ${tab === 'ai' ? 'active' : ''}`}
          onClick={() => { setTab('ai'); }}
        >
          🤖 AI Generator
        </button>
      </div>

      {msg && (
        <div className={`toast-notification ${msgType === 'error' ? 'toast-error' : ''}`}>
          {msg}
        </div>
      )}

      {tab === 'attempts' && (
        <div className="admin-section glass-card">
          <div className="section-header">
            <div className="section-title-group">
              <h2>Student Attempt Log</h2>
              <span className="count-badge">{attempts.length} record{attempts.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="section-actions">
              <div className="search-box">
                <span className="search-icon">🔍</span>
                <input
                  className="search-input"
                  placeholder="Filter by student or exam…"
                  value={attemptSearch}
                  onChange={(e) => setAttemptSearch(e.target.value)}
                />
              </div>
              {attempts.length > 0 && (
                <button className="danger-btn" onClick={clearAllAttempts}>
                  🗑️ Clear All ({attempts.length})
                </button>
              )}
            </div>
          </div>
          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th className="col-id">ID</th>
                  <th className="col-student">Student</th>
                  <th className="col-exam">Exam</th>
                  <th className="col-status">Status</th>
                  <th className="col-score">Score</th>
                  <th className="col-violations">Violations</th>
                  <th className="col-roughwork">Rough Work</th>
                  <th className="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const filtered = attempts.filter((a) => {
                    const q = attemptSearch.toLowerCase();
                    if (!q) return true;
                    return (
                      a.student.name.toLowerCase().includes(q) ||
                      a.student.email.toLowerCase().includes(q) ||
                      a.exam.title.toLowerCase().includes(q)
                    );
                  });
                  if (filtered.length === 0) {
                    return (
                      <tr>
                        <td colSpan="8" className="text-center">
                          {attemptSearch ? '🔍 No matches found.' : 'No student attempts recorded yet.'}
                        </td>
                      </tr>
                    );
                  }
                  return filtered.map((a) => (
                    <tr key={a.id} className={deletingAttemptId === a.id ? 'row-deleting' : ''}>
                      <td className="col-id">#{a.id}</td>
                      <td className="col-student">
                        <strong>{a.student.name}</strong>
                        <br />
                        <small>{a.student.email}</small>
                      </td>
                      <td className="col-exam">{a.exam.title}</td>
                      <td className="col-status">
                        <span className={`status-tag ${a.status}`}>
                          {a.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="col-score">
                        <span className="score-display">
                          <span className="score-value">{a.score}</span>
                          <span className="score-total">/{a.exam.total_marks}</span>
                        </span>
                      </td>
                      <td className="col-violations">
                        {a.violations.length === 0 ? (
                          <span className="clean-pill">✓ Clean</span>
                        ) : (
                          <div className="violation-list">
                            {a.violations.map((v) => (
                              <span key={v.id} className={`v-tag ${v.severity}`}>
                                {v.type.replace('AI_', '')}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="col-roughwork">
                        {a.rough_work ? (
                          a.rough_work.skipped ? (
                            <small className="muted">Skipped</small>
                          ) : (
                            <button
                              className="small-btn"
                              onClick={() => downloadRoughWork(a.rough_work.id, a.rough_work.file_name)}
                            >
                              📥 Download
                            </button>
                          )
                        ) : (
                          <small className="muted">Pending</small>
                        )}
                      </td>
                      <td className="col-actions" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <button
                          className="small-btn"
                          onClick={() => setInspectingAttempt(a)}
                          title="Inspect submission, student code and grade manually"
                          style={{ fontSize: '12px', padding: '4px 8px', backgroundColor: '#059669', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                        >
                          👁️ Inspect & Grade
                        </button>
                        <button
                          className="small-btn"
                          onClick={() => grantReattempt(a.id, a.student.name, a.exam.title)}
                          title="Grant student one additional attempt"
                          disabled={deletingAttemptId === a.id}
                          style={{ fontSize: '12px', padding: '4px 8px', backgroundColor: 'var(--primary-color, #4f46e5)', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                        >
                          🔄 Re-attempt
                        </button>
                        <button
                          className="delete-row-btn"
                          onClick={() => deleteAttempt(a.id)}
                          title="Delete this attempt"
                          disabled={deletingAttemptId === a.id}
                        >
                          {deletingAttemptId === a.id ? '…' : '✕'}
                        </button>
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'exams' && (
        <>
          {/* Existing Exams List */}
          <div className="admin-section glass-card" style={{ marginBottom: '24px' }}>
            <h2>Existing Exams</h2>
            {exams.length === 0 ? (
              <p className="muted" style={{ padding: '16px 0' }}>No exams created yet. Use the form below to create one.</p>
            ) : (
              <div className="exam-manage-list">
                {exams.map((e) => (
                  <div key={e.id} className="exam-manage-item">
                    <div className="exam-manage-info">
                      <div className="exam-manage-title">
                        <strong>{e.title}</strong>
                        {!e.active && <span className="status-tag auto_submitted">Inactive</span>}
                      </div>
                      <div className="exam-manage-meta">
                        <span>⏱️ {e.duration_minutes} min</span>
                        <span>📝 {e.questions.length} questions</span>
                        <span>💯 {e.total_marks} marks</span>
                        <span>⚠️ Max {e.max_violations} violations</span>
                      </div>
                    </div>
                    <button
                      className="danger-btn"
                      onClick={() => deleteExam(e.id, e.title)}
                    >
                      🗑️ Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Create Exam & Add Question Forms */}
          <div className="admin-grid">
            <div className="glass-card">
              <h2>Create New Exam</h2>
              <form onSubmit={handleCreateExam}>
                <div className="form-group">
                  <label>Exam Title</label>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Advanced Cybersecurity Midterm"
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Duration (Minutes)</label>
                  <input
                    type="number"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    min="1"
                    max="600"
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Max Allowed Violations</label>
                  <input
                    type="number"
                    value={maxViolations}
                    onChange={(e) => setMaxViolations(e.target.value)}
                    min="1"
                    max="20"
                    required
                  />
                </div>
                <button type="submit" className="primary-btn">
                  Create Exam
                </button>
              </form>
            </div>

            <div className="glass-card">
              <h2>Add Question to Exam</h2>
              {exams.length === 0 ? (
                <p className="muted" style={{ padding: '16px 0' }}>Create an exam first to add questions.</p>
              ) : (
                <form onSubmit={handleAddQuestion}>
                  <div className="form-group">
                    <label>Select Exam</label>
                    <select
                      value={selectedExamId}
                      onChange={(e) => setSelectedExamId(e.target.value)}
                    >
                      {exams.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.title} ({e.questions.length} Qs)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Question Type</label>
                    <div className="qtype-segmented-control">
                      <button
                        type="button"
                        className={`qtype-btn ${qType === 'mcq' ? 'active' : ''}`}
                        onClick={() => setQType('mcq')}
                      >
                        🔘 Multiple Choice
                      </button>
                      <button
                        type="button"
                        className={`qtype-btn ${qType === 'code' ? 'active' : ''}`}
                        onClick={() => setQType('code')}
                      >
                        💻 Coding Challenge
                      </button>
                      <button
                        type="button"
                        className={`qtype-btn ${qType === 'text' ? 'active' : ''}`}
                        onClick={() => setQType('text')}
                      >
                        📝 Written Answer
                      </button>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>{qType === 'code' ? 'Problem Statement / Coding Task' : 'Question Text'}</label>
                    <textarea
                      value={qText}
                      onChange={(e) => setQText(e.target.value)}
                      placeholder={
                        qType === 'code'
                          ? 'e.g. Write a python programming language code to take two numbers from the user and find their sum using Typecasting.'
                          : qType === 'text'
                          ? 'e.g. Explain the principles of Public Key Cryptography and Diffie-Hellman Key Exchange.'
                          : 'e.g. What does RSA stand for?'
                      }
                      rows={3}
                      required
                    />
                  </div>

                  {qType === 'mcq' && (
                    <>
                      <div className="options-grid">
                        <div className="form-group">
                          <label>Option A</label>
                          <input value={opt0} onChange={(e) => setOpt0(e.target.value)} required={qType === 'mcq'} />
                        </div>
                        <div className="form-group">
                          <label>Option B</label>
                          <input value={opt1} onChange={(e) => setOpt1(e.target.value)} required={qType === 'mcq'} />
                        </div>
                        <div className="form-group">
                          <label>Option C</label>
                          <input value={opt2} onChange={(e) => setOpt2(e.target.value)} required={qType === 'mcq'} />
                        </div>
                        <div className="form-group">
                          <label>Option D</label>
                          <input value={opt3} onChange={(e) => setOpt3(e.target.value)} required={qType === 'mcq'} />
                        </div>
                      </div>

                      <div className="form-group">
                        <label>Correct Option</label>
                        <select value={correct} onChange={(e) => setCorrect(e.target.value)}>
                          <option value="0">Option A</option>
                          <option value="1">Option B</option>
                          <option value="2">Option C</option>
                          <option value="3">Option D</option>
                        </select>
                      </div>
                    </>
                  )}

                  {qType === 'code' && (
                    <>
                      <div className="form-group">
                        <label>Programming Language</label>
                        <select value={qLang} onChange={(e) => setQLang(e.target.value)}>
                          <option value="python">🐍 Python 3</option>
                          <option value="javascript">⚡ JavaScript (Node.js)</option>
                          <option value="java">☕ Java</option>
                          <option value="cpp">⚙️ C / C++</option>
                          <option value="sql">🗄️ SQL</option>
                          <option value="plain_text">📄 Other / Plain Text</option>
                        </select>
                      </div>

                      <div className="form-group">
                        <label>Starter Code / Boilerplate <span className="optional-label">(optional)</span></label>
                        <textarea
                          value={qStarter}
                          onChange={(e) => setQStarter(e.target.value)}
                          placeholder="# Initial starter code or function definition provided to student..."
                          rows={4}
                          style={{ fontFamily: 'monospace' }}
                        />
                      </div>

                      <div className="form-group">
                        <label>Reference Solution / Rubric <span className="optional-label">(optional, visible only to admin/reviewer)</span></label>
                        <textarea
                          value={qSample}
                          onChange={(e) => setQSample(e.target.value)}
                          placeholder="Reference answer, expected output, or grading checklist..."
                          rows={4}
                          style={{ fontFamily: 'monospace' }}
                        />
                      </div>
                    </>
                  )}

                  {qType === 'text' && (
                    <>
                      <div className="form-group">
                        <label>Answer Template / Hint <span className="optional-label">(optional)</span></label>
                        <textarea
                          value={qStarter}
                          onChange={(e) => setQStarter(e.target.value)}
                          placeholder="Optional placeholder instructions for the candidate..."
                          rows={3}
                        />
                      </div>

                      <div className="form-group">
                        <label>Key Answer Points / Rubric <span className="optional-label">(optional)</span></label>
                        <textarea
                          value={qSample}
                          onChange={(e) => setQSample(e.target.value)}
                          placeholder="Key criteria or points to award full marks..."
                          rows={3}
                        />
                      </div>
                    </>
                  )}

                  <div className="form-group">
                    <label>Marks</label>
                    <input
                      type="number"
                      value={marks}
                      onChange={(e) => setMarks(e.target.value)}
                      min="1"
                      required
                    />
                  </div>

                  <button type="submit" className="primary-btn">
                    ➕ Add Question
                  </button>
                </form>
              )}
            </div>
          </div>
          </>
        )}

      {tab === 'subjects' && (
        <div className="subjects-tab">
          {/* Add Subject Form */}
          <div className="admin-section glass-card subjects-form-card">
            <div className="subjects-form-header">
              <h2>📚 Subject Management</h2>
              <p className="subtitle">Organise your exam catalogue by adding and managing subjects / disciplines.</p>
            </div>
            <form className="subjects-form" onSubmit={handleCreateSubject}>
              <div className="form-group">
                <label>Subject Name</label>
                <input
                  value={subjectName}
                  onChange={(e) => setSubjectName(e.target.value)}
                  placeholder="e.g. Advanced Mathematics, Organic Chemistry…"
                  required
                  maxLength={120}
                />
              </div>
              <div className="form-group">
                <label>Description <span className="optional-label">(optional)</span></label>
                <input
                  value={subjectDesc}
                  onChange={(e) => setSubjectDesc(e.target.value)}
                  placeholder="Brief description of this subject…"
                  maxLength={300}
                />
              </div>
              <button type="submit" className="primary-btn subjects-add-btn" disabled={subjectLoading || !subjectName.trim()}>
                {subjectLoading ? '⏳ Adding…' : '➕ Add Subject'}
              </button>
            </form>
          </div>

          {/* Subject Cards Grid */}
          <div className="subjects-grid-header">
            <span className="subjects-count">
              {subjects.length} Subject{subjects.length !== 1 ? 's' : ''}
            </span>
          </div>

          {subjects.length === 0 ? (
            <div className="subjects-empty glass-card">
              <div className="subjects-empty-icon">📚</div>
              <h3>No Subjects Yet</h3>
              <p>Use the form above to add your first subject category.</p>
            </div>
          ) : (
            <div className="subjects-grid">
              {subjects.map((s) => (
                <div
                  key={s.id}
                  className={`subject-card glass-card ${deletingSubjectId === s.id ? 'subject-card-deleting' : ''}`}
                >
                  <div className="subject-card-top">
                    <div className="subject-icon-wrap">📖</div>
                    <button
                      className="subject-delete-btn"
                      onClick={() => deleteSubject(s.id, s.name)}
                      disabled={deletingSubjectId === s.id}
                      title="Delete subject"
                    >
                      {deletingSubjectId === s.id ? '…' : '✕'}
                    </button>
                  </div>
                  <div className="subject-card-body">
                    <h3 className="subject-name">{s.name}</h3>
                    {s.description && (
                      <p className="subject-description">{s.description}</p>
                    )}
                    <div className="subject-card-footer">
                      <span className="subject-id-badge">#{s.id}</span>
                      <span className="subject-date">
                        {new Date(s.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'ai' && (
        <div className="ai-wizard">
          {/* Step Indicator */}
          <div className="ai-steps">
            {['Upload PDF', 'Review Questions', 'Publish Exam'].map((label, idx) => {
              const step = idx + 1;
              const done = aiStep > step;
              const active = aiStep === step;
              return (
                <React.Fragment key={step}>
                  <div className={`ai-step ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
                    <div className="ai-step-circle">
                      {done ? '✓' : step}
                    </div>
                    <span className="ai-step-label">{label}</span>
                  </div>
                  {idx < 2 && <div className={`ai-step-line ${done ? 'done' : ''}`} />}
                </React.Fragment>
              );
            })}
          </div>

          {/* Step 1: Upload & Configure */}
          {aiStep === 1 && (
            <div className="glass-card ai-card">
              <div className="ai-card-header">
                <div className="ai-icon-ring">🤖</div>
                <div>
                  <h2>AI Syllabus Analyser</h2>
                  <p className="subtitle">Upload a PDF syllabus — Gemini 2.0 Flash will generate exam-ready MCQs automatically.</p>
                </div>
              </div>

              <form onSubmit={handleAnalyzeSyllabus} className="ai-upload-form">
                {/* Drop Zone */}
                <div
                  className={`ai-dropzone ${aiFile ? 'has-file' : ''}`}
                  onClick={() => aiFileRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files[0];
                    if (f && f.name.endsWith('.pdf')) setAiFile(f);
                  }}
                >
                  <input
                    ref={aiFileRef}
                    type="file"
                    accept=".pdf"
                    style={{ display: 'none' }}
                    onChange={(e) => setAiFile(e.target.files?.[0] || null)}
                  />
                  <div className="ai-dropzone-icon">{aiFile ? '📄' : '📂'}</div>
                  {aiFile ? (
                    <div className="ai-dropzone-file">
                      <strong>{aiFile.name}</strong>
                      <span className="ai-file-size">({(aiFile.size / 1024).toFixed(0)} KB)</span>
                      <button
                        type="button"
                        className="ai-file-remove"
                        onClick={(e) => { e.stopPropagation(); setAiFile(null); if (aiFileRef.current) aiFileRef.current.value = ''; }}
                      >✕</button>
                    </div>
                  ) : (
                    <>
                      <p className="ai-dropzone-text">Drag & drop a PDF here, or <span className="ai-browse-link">browse</span></p>
                      <p className="ai-dropzone-hint">Supports text-based PDFs up to {10} MB</p>
                    </>
                  )}
                </div>

                {/* Controls: Questions count */}
                <div className="form-group">
                  <label>Number of Questions <span className="ai-q-count-badge">{aiNumQ}</span></label>
                  <input
                    type="range"
                    min="5"
                    max="30"
                    value={aiNumQ}
                    onChange={(e) => setAiNumQ(Number(e.target.value))}
                    className="ai-slider"
                  />
                  <div className="ai-slider-labels">
                    <span>5</span><span>30</span>
                  </div>
                </div>

                {/* Subject Picker */}
                <div className="ai-subject-section">
                  <div className="ai-subject-label">
                    <span className="ai-subject-label-text">📚 Subject Context</span>
                    <span className="optional-label">(helps Gemini understand the domain)</span>
                  </div>

                  {subjects.length === 0 ? (
                    <div className="ai-subject-empty">
                      No subjects found. <button type="button" className="link-btn" style={{margin:0,fontSize:'13px'}} onClick={() => setTab('subjects')}>Add subjects →</button>
                    </div>
                  ) : (
                    <div className="ai-subject-grid">
                      {/* None option */}
                      <button
                        type="button"
                        className={`ai-subject-tile ai-subject-none ${!aiSubjectId ? 'selected' : ''}`}
                        onClick={() => { setAiSubjectId(''); setAiHint(''); }}
                      >
                        <span className="ai-subject-tile-icon">—</span>
                        <span className="ai-subject-tile-name">No Subject</span>
                      </button>

                      {/* Subject tiles from DB */}
                      {subjects.map((s) => (
                        <button
                          type="button"
                          key={s.id}
                          className={`ai-subject-tile ${String(aiSubjectId) === String(s.id) ? 'selected' : ''}`}
                          onClick={() => { setAiSubjectId(String(s.id)); setAiHint(''); }}
                        >
                          <span className="ai-subject-tile-icon">📖</span>
                          <span className="ai-subject-tile-name">{s.name}</span>
                          {s.description && (
                            <span className="ai-subject-tile-desc">{s.description}</span>
                          )}
                        </button>
                      ))}

                      {/* Custom option */}
                      <button
                        type="button"
                        className={`ai-subject-tile ai-subject-custom ${aiSubjectId === 'custom' ? 'selected' : ''}`}
                        onClick={() => setAiSubjectId('custom')}
                      >
                        <span className="ai-subject-tile-icon">✏️</span>
                        <span className="ai-subject-tile-name">Custom hint</span>
                      </button>
                    </div>
                  )}

                  {/* Custom hint text field — only visible when 'custom' selected */}
                  {aiSubjectId === 'custom' && (
                    <div className="ai-custom-hint">
                      <input
                        value={aiHint}
                        onChange={(e) => setAiHint(e.target.value)}
                        placeholder="e.g. Chapter 5: Organic Chemistry — reaction mechanisms, alkyl halides…"
                        autoFocus
                      />
                    </div>
                  )}

                  {/* Preview of selected subject context */}
                  {aiSubjectId && aiSubjectId !== 'custom' && (() => {
                    const sub = subjects.find((s) => String(s.id) === aiSubjectId);
                    if (!sub) return null;
                    const ctx = sub.description ? `Subject: ${sub.name} — ${sub.description}` : `Subject: ${sub.name}`;
                    return (
                      <div className="ai-subject-preview">
                        <span className="ai-subject-preview-label">Context sent to AI:</span>
                        <span className="ai-subject-preview-text">"{ctx}"</span>
                      </div>
                    );
                  })()}
                </div>

                {aiError && <div className="ai-error">{aiError}</div>}

                <button
                  type="submit"
                  className={`primary-btn ai-analyze-btn ${aiLoading ? 'loading' : ''}`}
                  disabled={!aiFile || aiLoading}
                >
                  {aiLoading ? (
                    <span className="ai-loading-inner"><span className="ai-spinner" />Analysing PDF with Gemini AI…</span>
                  ) : '🚀 Analyse Syllabus & Generate Questions'}
                </button>
              </form>
            </div>
          )}

          {/* Step 2: Review Questions */}
          {aiStep === 2 && (
            <div className="ai-review-container">
              <div className="ai-review-header glass-card">
                <div>
                  <h2>Review Generated Questions</h2>
                  <p className="subtitle">
                    {aiQuestions.length} questions generated · {Object.values(aiSelected).filter(Boolean).length} selected
                  </p>
                </div>
                <div className="ai-review-actions">
                  <button className="secondary-btn" onClick={() => aiToggleAll(true)}>Select All</button>
                  <button className="secondary-btn" onClick={() => aiToggleAll(false)}>Deselect All</button>
                  <button className="secondary-btn" onClick={resetAiWizard}>↩ Start Over</button>
                  <button
                    className="primary-btn"
                    style={{ width: 'auto', padding: '10px 24px' }}
                    onClick={() => {
                      if (Object.values(aiSelected).filter(Boolean).length === 0) {
                        setAiError('Select at least one question.');
                        return;
                      }
                      setAiError('');
                      setAiStep(3);
                    }}
                  >
                    Next: Set Up Exam →
                  </button>
                </div>
              </div>

              {aiError && <div className="ai-error">{aiError}</div>}

              <div className="ai-question-list">
                {aiQuestions.map((_, i) => {
                  const q = aiGetQuestion(i);
                  const isSelected = aiSelected[i];
                  const isEditing = Boolean(aiEditing[i]);
                  const diffColor = q.difficulty === 'easy' ? 'easy' : q.difficulty === 'hard' ? 'hard' : 'medium';
                  return (
                    <div key={i} className={`ai-question-card glass-card ${isSelected ? '' : 'ai-q-deselected'}`}>
                      <div className="ai-q-top">
                        <label className="ai-q-checkbox">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => setAiSelected(prev => ({ ...prev, [i]: e.target.checked }))}
                          />
                          <span className="ai-q-number">Q{i + 1}</span>
                        </label>
                        <span className={`ai-diff-badge diff-${diffColor}`}>{q.difficulty}</span>
                        <span className="ai-marks-label">{q.marks} mark{q.marks > 1 ? 's' : ''}</span>
                        <button
                          className={`ai-edit-btn ${isEditing ? 'active' : ''}`}
                          onClick={() => {
                            if (isEditing) {
                              setAiEditing(prev => { const n = {...prev}; delete n[i]; return n; });
                            } else {
                              setAiEditing(prev => ({ ...prev, [i]: { ...aiQuestions[i] } }));
                            }
                          }}
                        >
                          {isEditing ? '✓ Done' : '✏️ Edit'}
                        </button>
                      </div>

                      {isEditing ? (
                        <div className="ai-q-edit-body">
                          <div className="form-group">
                            <label>Question Text</label>
                            <input
                              value={q.text}
                              onChange={(e) => aiUpdateEdit(i, 'text', e.target.value)}
                            />
                          </div>
                          <div className="ai-options-edit">
                            {q.options.map((opt, oi) => (
                              <div key={oi} className="ai-option-edit-row">
                                <button
                                  type="button"
                                  className={`ai-correct-toggle ${q.correct_answer === oi ? 'correct' : ''}`}
                                  onClick={() => aiUpdateEdit(i, 'correct_answer', oi)}
                                  title="Set as correct answer"
                                >
                                  {String.fromCharCode(65 + oi)}
                                </button>
                                <input
                                  value={opt}
                                  onChange={(e) => aiUpdateOption(i, oi, e.target.value)}
                                  placeholder={`Option ${String.fromCharCode(65 + oi)}`}
                                />
                              </div>
                            ))}
                          </div>
                          <div className="ai-marks-row">
                            <label>Marks:</label>
                            <select
                              value={q.marks}
                              onChange={(e) => aiUpdateEdit(i, 'marks', Number(e.target.value))}
                            >
                              {[1,2,3,4,5].map(m => <option key={m} value={m}>{m}</option>)}
                            </select>
                          </div>
                        </div>
                      ) : (
                        <div className="ai-q-view-body">
                          <p className="ai-q-text">{q.text}</p>
                          <div className="ai-q-options">
                            {q.options.map((opt, oi) => (
                              <div key={oi} className={`ai-q-option ${q.correct_answer === oi ? 'correct' : ''}`}>
                                <span className="ai-opt-letter">{String.fromCharCode(65 + oi)}</span>
                                <span>{opt}</span>
                                {q.correct_answer === oi && <span className="ai-correct-tick">✓ Correct</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 3: Publish Exam / Success */}
          {aiStep === 3 && !aiSuccess && (
            <div className="glass-card ai-card">
              <h2>🚀 Publish as Exam</h2>
              <p className="subtitle">
                {Object.values(aiSelected).filter(Boolean).length} questions selected · configure exam settings below.
              </p>

              <form onSubmit={handlePublishExam} className="ai-publish-form">
                <div className="form-group">
                  <label>Exam Title</label>
                  <input
                    value={aiExamTitle}
                    onChange={(e) => setAiExamTitle(e.target.value)}
                    placeholder="e.g. Organic Chemistry Midterm 2026"
                    required
                  />
                </div>
                <div className="ai-publish-grid">
                  <div className="form-group">
                    <label>Duration (Minutes)</label>
                    <input
                      type="number"
                      value={aiDuration}
                      onChange={(e) => setAiDuration(e.target.value)}
                      min="5" max="600"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Max Violations</label>
                    <input
                      type="number"
                      value={aiMaxViol}
                      onChange={(e) => setAiMaxViol(e.target.value)}
                      min="1" max="20"
                      required
                    />
                  </div>
                </div>

                {aiError && <div className="ai-error">{aiError}</div>}

                <div className="ai-publish-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => { setAiError(''); setAiStep(2); }}
                  >
                    ← Back to Review
                  </button>
                  <button
                    type="submit"
                    className="primary-btn success ai-publish-btn"
                    disabled={aiPublishing}
                  >
                    {aiPublishing
                      ? <span className="ai-loading-inner"><span className="ai-spinner" />Publishing…</span>
                      : '✅ Publish Exam'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Step 3: Success State */}
          {aiStep === 3 && aiSuccess && (
            <div className="glass-card ai-card ai-success-card">
              <div className="ai-success-icon">🎉</div>
              <h2>Exam Published!</h2>
              <p className="subtitle">Your AI-generated exam is live and students can now attempt it.</p>
              <div className="ai-success-stats">
                <div className="ai-stat">
                  <span className="ai-stat-value">{aiSuccess.question_count}</span>
                  <span className="ai-stat-label">Questions</span>
                </div>
                <div className="ai-stat">
                  <span className="ai-stat-value">{aiSuccess.total_marks}</span>
                  <span className="ai-stat-label">Total Marks</span>
                </div>
                <div className="ai-stat">
                  <span className="ai-stat-value">#{aiSuccess.exam_id}</span>
                  <span className="ai-stat-label">Exam ID</span>
                </div>
              </div>
              <p className="ai-success-title">"{aiSuccess.title}"</p>
              <div className="ai-success-actions">
                <button
                  className="primary-btn"
                  onClick={() => { resetAiWizard(); setTab('exams'); loadData(); }}
                >
                  View in Exams Tab
                </button>
                <button className="secondary-btn" onClick={resetAiWizard}>
                  Generate Another Exam
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {inspectingAttempt && (
        <AttemptInspectModal
          attempt={inspectingAttempt}
          onClose={() => setInspectingAttempt(null)}
          onGraded={() => loadData()}
        />
      )}
    </div>
  );
}

function StudentDashboard({ user, onLogout, onStartExam, onVerifyClick }) {
  const [exams, setExams] = useState([]);
  const [err, setErr] = useState('');
  const [joinToken, setJoinToken] = useState('');
  const [joinMsg, setJoinMsg] = useState('');
  const [joinErr, setJoinErr] = useState('');
  const [joinLoading, setJoinLoading] = useState(false);
  const [faculties, setFaculties] = useState([]);

  useEffect(() => {
    api('/exams')
      .then(setExams)
      .catch((e) => setErr(e.message));
    api('/student/faculties')
      .then((res) => setFaculties(res.faculties || []))
      .catch(() => {});
  }, []);

  async function handleJoinFaculty(e) {
    e.preventDefault();
    if (!joinToken.trim()) return;
    setJoinLoading(true);
    setJoinErr('');
    setJoinMsg('');
    try {
      const res = await api('/student/join-faculty', {
        method: 'POST',
        body: JSON.stringify({ invite_token: joinToken.trim() }),
      });
      setJoinMsg(`✅ ${res.message}`);
      setJoinToken('');
      // Refresh faculties list
      const fRes = await api('/student/faculties');
      setFaculties(fRes.faculties || []);
    } catch (err) {
      setJoinErr(err.message);
    } finally {
      setJoinLoading(false);
    }
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ margin: 0 }}>Student Portal</h1>
            {user.isAccountVerified ? (
              <span className="verification-badge-verified">✓ Verified</span>
            ) : (
              <span className="verification-badge-unverified" style={{ cursor: 'pointer' }} onClick={onVerifyClick} title="Click to verify email">
                ⚠️ Unverified (Click to verify)
              </span>
            )}
          </div>
          <p style={{ margin: '4px 0 0 0' }}>Welcome back, <strong>{user.name}</strong> ({user.email})</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <ThemeToggle />
          <button onClick={onLogout} className="secondary-btn">
            Logout
          </button>
        </div>
      </header>

      {!user.isAccountVerified && (
        <div className="verification-banner">
          <div className="verification-banner-content">
            <span style={{ fontSize: '18px' }}>⚠️</span>
            <div>
              <strong>Email Verification Required:</strong> Please verify your email using the 6-digit OTP sent to your inbox.
            </div>
          </div>
          <button type="button" onClick={onVerifyClick} className="primary-btn" style={{ padding: '6px 14px', fontSize: '12.5px' }}>
            Verify Email
          </button>
        </div>
      )}

      {/* ── Join Faculty Section ───────────────────── */}
      <div className="faculty-join-section glass-card">
        <h3 style={{ margin: '0 0 12px 0' }}>🏫 Join Faculty</h3>
        <form onSubmit={handleJoinFaculty} className="join-faculty-form">
          <input
            type="text"
            placeholder="Paste invite URL or token…"
            value={joinToken}
            onChange={(e) => { setJoinToken(e.target.value); setJoinErr(''); setJoinMsg(''); }}
            className="join-input"
          />
          <button type="submit" className="primary-btn" disabled={joinLoading || !joinToken.trim()}>
            {joinLoading ? 'Joining…' : 'Join Faculty'}
          </button>
        </form>
        {joinMsg && <div className="success-badge" style={{ marginTop: '8px' }}>{joinMsg}</div>}
        {joinErr && <div className="error-badge" style={{ marginTop: '8px' }}>{joinErr}</div>}
      </div>

      {/* ── My Faculties ───────────────────── */}
      {faculties.length > 0 && (
        <div className="my-faculties-section">
          <h2>👩‍🏫 My Faculties</h2>
          <div className="faculty-cards">
            {faculties.map((f) => (
              <div key={f.id} className="faculty-card glass-card">
                <div className="faculty-card-icon">🏫</div>
                <div className="faculty-card-info">
                  <strong>{f.name}</strong>
                  <span className="faculty-card-email">{f.email}</span>
                  <span className="faculty-card-date">Joined {f.joined_at ? new Date(f.joined_at).toLocaleDateString() : '—'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <h2>Available Exams</h2>
      {err && <div className="error-badge">{err}</div>}

      <div className="exams-list">
        {exams.length === 0 ? (
          <div className="glass-card">No active exams available at this time.</div>
        ) : (
          exams.map((e) => {
            const hasAttempt = Boolean(e.attempt);
            const isCompleted = hasAttempt && e.attempt.status !== 'in_progress';
            return (
              <div key={e.id} className="exam-card glass-card">
                <div className="exam-card-info">
                  <h3>{e.title}</h3>
                  <div className="exam-meta">
                    <span>⏱️ {e.duration_minutes} Mins</span>
                    <span>💯 {e.total_marks} Marks</span>
                    <span>⚠️ Max {e.max_violations} Violations</span>
                  </div>
                  {hasAttempt && (
                    <div className="attempt-badge">
                      Previous Attempt Status: <strong className={e.attempt.status}>{e.attempt.status}</strong>
                      {isCompleted && ` (Score: ${e.attempt.score})`}
                    </div>
                  )}
                </div>
                <div className="exam-card-action">
                  <button
                    className={`primary-btn ${isCompleted ? 'disabled' : ''}`}
                    disabled={isCompleted}
                    onClick={async () => {
                      try {
                        const d = await api(`/exams/${e.id}/start`, { method: 'POST' });
                        onStartExam(d);
                      } catch (err) {
                        alert(err.message);
                      }
                    }}
                  >
                    {isCompleted ? 'Attempt Completed' : hasAttempt ? 'Resume Exam' : 'Start Exam'}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}


function FacultyDashboard({ user, onLogout, onVerifyClick }) {
  const [inviteToken, setInviteToken] = useState('');
  const [students, setStudents] = useState([]);
  const [copied, setCopied] = useState(false);
  const [regenLoading, setRegenLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState('info');

  useEffect(() => {
    api('/faculty/invite')
      .then((res) => setInviteToken(res.invite_token || ''))
      .catch((e) => showMsg(e.message, 'error'));
    api('/faculty/students')
      .then((res) => setStudents(res.students || []))
      .catch(() => {});
  }, []);

  function showMsg(text, type = 'info') {
    setMsg(text);
    setMsgType(type);
    setTimeout(() => setMsg(''), 4000);
  }

  function getInviteUrl() {
    return `${window.location.origin}/#/join/${inviteToken}`;
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(getInviteUrl());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const el = document.createElement('textarea');
      el.value = getInviteUrl();
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  async function handleRegenerate() {
    setRegenLoading(true);
    try {
      const res = await api('/faculty/invite/regenerate', { method: 'POST' });
      setInviteToken(res.invite_token || '');
      showMsg('✅ Invite link regenerated. Previous link is now invalid.');
    } catch (e) {
      showMsg(e.message, 'error');
    } finally {
      setRegenLoading(false);
    }
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ margin: 0 }}>🏫 Faculty Portal</h1>
            {user.isAccountVerified ? (
              <span className="verification-badge-verified">✓ Verified</span>
            ) : (
              <span className="verification-badge-unverified" style={{ cursor: 'pointer' }} onClick={onVerifyClick} title="Click to verify email">
                ⚠️ Unverified (Click to verify)
              </span>
            )}
          </div>
          <p style={{ margin: '4px 0 0 0' }}>Welcome, <strong>{user.name}</strong> ({user.email})</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <ThemeToggle />
          <button onClick={onLogout} className="secondary-btn">
            Logout
          </button>
        </div>
      </header>

      {!user.isAccountVerified && (
        <div className="verification-banner">
          <div className="verification-banner-content">
            <span style={{ fontSize: '18px' }}>⚠️</span>
            <div>
              <strong>Email Verification Pending:</strong> Please verify your email to ensure full account protection.
            </div>
          </div>
          <button type="button" onClick={onVerifyClick} className="primary-btn" style={{ padding: '6px 14px', fontSize: '12.5px' }}>
            Verify Email
          </button>
        </div>
      )}

      {msg && (
        <div className={`toast-notification ${msgType === 'error' ? 'toast-error' : ''}`}>
          {msg}
        </div>
      )}

      {/* ── Invite Link Section ───────────────────── */}
      <div className="invite-section glass-card">
        <h2 style={{ margin: '0 0 12px 0' }}>🔗 Student Invite Link</h2>
        <p className="subtitle" style={{ margin: '0 0 12px 0' }}>Share this link with students to let them join your class.</p>
        {inviteToken ? (
          <>
            <div className="invite-url-box">
              <code className="invite-url-text">{getInviteUrl()}</code>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
              <button className="primary-btn" onClick={handleCopy} style={{ minWidth: '120px' }}>
                {copied ? '✓ Copied!' : '📋 Copy Link'}
              </button>
              <button className="secondary-btn" onClick={handleRegenerate} disabled={regenLoading} style={{ minWidth: '150px' }}>
                {regenLoading ? 'Regenerating…' : '🔄 Regenerate Link'}
              </button>
            </div>
          </>
        ) : (
          <p>Loading invite link…</p>
        )}
      </div>

      {/* ── My Students Section ───────────────────── */}
      <div className="my-students-section">
        <h2>👩‍🎓 My Students ({students.length})</h2>
        {students.length === 0 ? (
          <div className="glass-card" style={{ textAlign: 'center', padding: '32px' }}>
            <p style={{ fontSize: '16px', opacity: 0.7 }}>No students have joined yet.</p>
            <p style={{ fontSize: '13px', opacity: 0.5 }}>Share your invite link above to get started.</p>
          </div>
        ) : (
          <div className="students-table-wrapper glass-card">
            <table className="students-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s, idx) => (
                  <tr key={s.id}>
                    <td>{idx + 1}</td>
                    <td><strong>{s.name}</strong></td>
                    <td>{s.email}</td>
                    <td>{s.joined_at ? new Date(s.joined_at).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}


function JoinFacultyPage({ user, inviteToken, onDone, onLogout }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!inviteToken) {
      setErr('No invite token provided');
      setLoading(false);
      return;
    }
    api(`/invite/${encodeURIComponent(inviteToken)}/info`)
      .then((res) => {
        setInfo(res);
        setLoading(false);
      })
      .catch((e) => {
        setErr(e.message || 'Invalid invite link');
        setLoading(false);
      });
  }, [inviteToken]);

  async function handleJoin() {
    setJoining(true);
    setErr('');
    try {
      const res = await api('/student/join-faculty', {
        method: 'POST',
        body: JSON.stringify({ invite_token: inviteToken }),
      });
      setMsg(`✅ ${res.message}`);
      setTimeout(() => {
        window.location.hash = '';
        onDone();
      }, 1500);
    } catch (e) {
      setErr(e.message);
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="center">
      <div className="card glass-card" style={{ maxWidth: '480px', textAlign: 'center' }}>
        <div className="brand-header">
          <div className="shield-icon">🏫</div>
          <h1 style={{ fontSize: '1.5rem' }}>Join Faculty</h1>
        </div>

        {loading ? (
          <p style={{ padding: '24px 0' }}>Verifying invite link…</p>
        ) : err && !info ? (
          <>
            <div className="error-badge" style={{ marginBottom: '16px' }}>{err}</div>
            <button className="secondary-btn" onClick={() => { window.location.hash = ''; onDone(); }}>
              ← Back to Dashboard
            </button>
          </>
        ) : info && info.user_role !== 'student' ? (
          <>
            <div className="error-badge" style={{ marginBottom: '16px' }}>
              Only student accounts can join faculties. You are logged in as <strong>{info.user_role}</strong>.
            </div>
            <button className="secondary-btn" onClick={() => { window.location.hash = ''; onDone(); }}>
              ← Back to Dashboard
            </button>
          </>
        ) : info && info.already_joined ? (
          <>
            <div style={{ padding: '16px 0' }}>
              <div style={{ fontSize: '48px', marginBottom: '12px' }}>✅</div>
              <h3>Already Joined</h3>
              <p>You are already a member of <strong>{info.faculty_name}</strong>'s class.</p>
            </div>
            <button className="primary-btn" onClick={() => { window.location.hash = ''; onDone(); }}>
              ← Back to Dashboard
            </button>
          </>
        ) : info ? (
          <>
            <div style={{ padding: '16px 0' }}>
              <div style={{ fontSize: '48px', marginBottom: '12px' }}>👩‍🏫</div>
              <h3 style={{ marginBottom: '4px' }}>{info.faculty_name}</h3>
              <p className="subtitle">{info.faculty_email}</p>
              <p style={{ marginTop: '12px' }}>You are about to join this faculty's class.</p>
            </div>
            {msg && <div className="success-badge" style={{ marginBottom: '12px' }}>{msg}</div>}
            {err && <div className="error-badge" style={{ marginBottom: '12px' }}>{err}</div>}
            {!msg && (
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                <button className="primary-btn" onClick={handleJoin} disabled={joining}>
                  {joining ? 'Joining…' : '✓ Join Faculty'}
                </button>
                <button className="secondary-btn" onClick={() => { window.location.hash = ''; onDone(); }}>
                  Cancel
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}


function App() {
  const [user, setUser] = useState(getUser());
  const [attempt, setAttempt] = useState(null);
  const [rough, setRough] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [hashPath, setHashPath] = useState(window.location.hash);

  // Listen for hash changes
  useEffect(() => {
    function onHashChange() {
      setHashPath(window.location.hash);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    localStorage.clear();
    setUser(null);
    setAttempt(null);
    setRough(false);
    setShowVerifyModal(false);
  }, []);

  useEffect(() => {
    function handleUnauthorized() {
      logout();
    }
    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized);
  }, [logout]);

  // Sync user verification profile on load
  useEffect(() => {
    if (token()) {
      api('/user/data')
        .then((res) => {
          if (res.userData) {
            setUser((prev) => {
              const merged = { ...(prev || {}), ...res.userData };
              localStorage.setItem('user', JSON.stringify(merged));
              return merged;
            });
          }
        })
        .catch(() => {});
    }
  }, []);

  // Parse join invite token from hash: #/join/TOKEN
  const joinMatch = hashPath.match(/^#\/join\/(.+)$/);
  const pendingInviteToken = joinMatch ? joinMatch[1] : null;

  // Not logged in
  if (!token() || !user) {
    // If there's a pending invite, store it and show login
    if (pendingInviteToken) {
      localStorage.setItem('pendingInviteToken', pendingInviteToken);
    }
    return <Login onLogin={(u) => setUser(u)} />;
  }

  // After login, check for pending invite
  const storedInvite = localStorage.getItem('pendingInviteToken');
  if (storedInvite && !pendingInviteToken) {
    // Redirect to the join page
    localStorage.removeItem('pendingInviteToken');
    window.location.hash = `#/join/${storedInvite}`;
  }

  // Show join page if hash matches
  if (pendingInviteToken) {
    return (
      <JoinFacultyPage
        user={user}
        inviteToken={pendingInviteToken}
        onDone={() => setHashPath('')}
        onLogout={logout}
      />
    );
  }

  return (
    <>
      {user.role === 'admin' ? (
        <AdminDashboard
          user={user}
          onLogout={logout}
          onVerifyClick={() => setShowVerifyModal(true)}
        />
      ) : user.role === 'faculty' ? (
        <FacultyDashboard
          user={user}
          onLogout={logout}
          onVerifyClick={() => setShowVerifyModal(true)}
        />
      ) : rough && attempt ? (
        <RoughWork
          attemptId={attempt.attempt_id || attempt.id}
          onDone={() => {
            setRough(false);
            setAttempt(null);
          }}
        />
      ) : attempt ? (
        <Exam
          attempt={attempt}
          onFinish={(status) => {
            if (status === 'cancel') {
              setAttempt(null);
            } else {
              setRough(true);
            }
          }}
        />
      ) : (
        <StudentDashboard
          user={user}
          onLogout={logout}
          onStartExam={(att) => setAttempt(att)}
          onVerifyClick={() => setShowVerifyModal(true)}
        />
      )}

      {showVerifyModal && (
        <EmailVerifyModal
          user={user}
          onClose={() => setShowVerifyModal(false)}
          onVerified={(updatedUser) => setUser(updatedUser)}
        />
      )}
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
