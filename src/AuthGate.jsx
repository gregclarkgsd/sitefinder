import React, { useEffect, useState } from 'react';
import { Building2, KeyRound, LogIn, UserPlus } from 'lucide-react';
import { cloudEnabled, supabase } from './supabase';
import './auth.css';

const isGsdEmail = value => value.trim().toLowerCase().endsWith('@gsdecorating.com');

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(!cloudEnabled);
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase) return undefined;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === 'PASSWORD_RECOVERY') {
        setMode('recovery');
        setSession(null);
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="auth-page">Checking your session…</div>;
  if (!cloudEnabled) return children({ session: null, cloudEnabled: false });
  if (session && mode !== 'recovery') return children({ session, cloudEnabled: true });

  const submit = async event => {
    event.preventDefault();
    setMessage('');

    if (mode === 'recovery') {
      if (password.length < 8) return setMessage('Use at least 8 characters for your new password.');
      if (password !== confirmPassword) return setMessage('The passwords do not match.');
      setBusy(true);
      const { error } = await supabase.auth.updateUser({ password });
      setBusy(false);
      if (error) return setMessage(error.message);
      setMode('login');
      setPassword('');
      setConfirmPassword('');
      return setMessage('Password updated. You can now sign in.');
    }

    if (!isGsdEmail(email)) return setMessage('Use your @gsdecorating.com work email.');
    setBusy(true);

    if (mode === 'forgot') {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: `${location.origin}/`,
      });
      setBusy(false);
      return setMessage(error ? error.message : 'Check your work email for the password reset link.');
    }

    if (password.length < 8) {
      setBusy(false);
      return setMessage('Your password must be at least 8 characters.');
    }

    if (mode === 'signup') {
      if (password !== confirmPassword) {
        setBusy(false);
        return setMessage('The passwords do not match.');
      }
      const { data, error } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: { emailRedirectTo: `${location.origin}/` },
      });
      setBusy(false);
      if (error) return setMessage(error.message);
      return setMessage(data.session
        ? 'Account created. You are now signed in.'
        : 'Account created. Check your work email to confirm it, then sign in.');
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    setBusy(false);
    if (error) setMessage(error.message === 'Invalid login credentials'
      ? 'Email or password not recognised.'
      : error.message);
  };

  const switchMode = nextMode => {
    setMode(nextMode);
    setMessage('');
    setPassword('');
    setConfirmPassword('');
  };

  const title = mode === 'signup'
    ? 'Create your GSD account'
    : mode === 'forgot'
      ? 'Reset your password'
      : mode === 'recovery'
        ? 'Choose a new password'
        : 'Sign in to project leads';

  return <div className="auth-page">
    <form className="auth-card" onSubmit={submit}>
      <div className="auth-brand"><Building2/><b>GSD</b> SiteFinder</div>
      {mode !== 'recovery' && <div className="auth-tabs" role="tablist" aria-label="Account access">
        <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>Log in</button>
        <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} onClick={() => switchMode('signup')}>Sign up</button>
      </div>}
      <h1>{title}</h1>
      <p>{mode === 'forgot'
        ? 'We will send a reset link to your GSD work email.'
        : 'Access is restricted to authorised GSD Decorating employees.'}</p>

      {mode !== 'recovery' && <label>Work email
        <input type="email" required autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@gsdecorating.com"/>
      </label>}
      {mode !== 'forgot' && <label>{mode === 'recovery' ? 'New password' : 'Password'}
        <input type="password" required minLength="8" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 8 characters"/>
      </label>}
      {(mode === 'signup' || mode === 'recovery') && <label>Confirm password
        <input type="password" required minLength="8" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="Repeat your password"/>
      </label>}

      <button className="auth-submit" disabled={busy}>
        {mode === 'signup' ? <UserPlus size={17}/> : mode === 'login' ? <LogIn size={17}/> : <KeyRound size={17}/>}
        {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : mode === 'login' ? 'Log in' : mode === 'forgot' ? 'Send reset link' : 'Save new password'}
      </button>

      {mode === 'login' && <button type="button" className="auth-link" onClick={() => switchMode('forgot')}>Forgotten your password?</button>}
      {mode === 'forgot' && <button type="button" className="auth-link" onClick={() => switchMode('login')}>Back to log in</button>}
      {message && <output role="status">{message}</output>}
    </form>
  </div>;
}
