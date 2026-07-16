import React, { useEffect, useState } from 'react';
import { Building2, Mail } from 'lucide-react';
import { cloudEnabled, supabase } from './supabase';
import './auth.css';

export default function AuthGate({children}) {
  const [session,setSession]=useState(null), [ready,setReady]=useState(!cloudEnabled), [email,setEmail]=useState(''), [message,setMessage]=useState('');
  useEffect(()=>{ if(!supabase) return; supabase.auth.getSession().then(({data})=>{setSession(data.session);setReady(true)}); const {data}=supabase.auth.onAuthStateChange((_event,next)=>setSession(next)); return()=>data.subscription.unsubscribe() },[]);
  if(!ready) return <div className="auth-page">Checking your session…</div>;
  if(!cloudEnabled) return children({session:null,cloudEnabled:false});
  if(session) return children({session,cloudEnabled:true});
  const submit=async e=>{e.preventDefault();setMessage('');if(!email.toLowerCase().endsWith('@gsdecorating.com')) return setMessage('Use your @gsdecorating.com work email.');const {error}=await supabase.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin}});setMessage(error?error.message:'Check your email for your secure sign-in link.')};
  return <div className="auth-page"><form className="auth-card" onSubmit={submit}><div className="auth-brand"><Building2/><b>GSD</b> SiteFinder</div><h1>Sign in to project leads</h1><p>Access is restricted to authorised GSD Decorating employees.</p><label>Work email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@gsdecorating.com"/></label><button><Mail size={17}/> Email me a sign-in link</button>{message&&<output>{message}</output>}</form></div>
}
