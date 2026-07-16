/* ===========================================================
   Savings Tracking System — app.js
   Now backed by Firebase Firestore (real shared database,
   synced live across every device) instead of localStorage.
=========================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore,
  collection, doc, addDoc, updateDoc, deleteDoc, getDoc, getDocs,
  query, where, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- Firebase project connection ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyC24cfjiXcqscZPeDgcCuWYiPPxuSZrXJI",
  authDomain: "savings-tracker-c2001.firebaseapp.com",
  projectId: "savings-tracker-c2001",
  storageBucket: "savings-tracker-c2001.firebasestorage.app",
  messagingSenderId: "1018765427298",
  appId: "1:1018765427298:web:99131c2142c336a0bfc73b"
};
const fbApp = initializeApp(firebaseConfig);
// Force long-polling instead of Firestore's default streaming connection.
// Some mobile networks and restrictive connections silently swallow the
// default connection type with no error at all — writes just hang
// forever. Long-polling uses plain HTTP requests instead, which works
// reliably on virtually every network, including ones that hang on the
// default transport.
const db = initializeFirestore(fbApp, {
  experimentalForceLongPolling: true
});

const colAdmins   = collection(db, 'admins'); // kept for reference; no longer used for login
const colClients  = collection(db, 'clients');
const colSavings  = collection(db, 'savingsEntries');
const colLoans    = collection(db, 'loans');
const colPayments = collection(db, 'loanPayments');
const colMessages = collection(db, 'messages');

/* ---------- Admin accounts (fixed — not stored in Firestore) ----------
   Only two admins exist and they don't change. Keeping them here removes
   an entire class of bugs caused by hand-typing exact-match credentials
   into a mobile Firestore console. */
const ADMIN_ACCOUNTS = [
  { id: 'musa', username: 'Alhj.musa.dahiru', password: 'Musa8065@#', name: 'Alhj. Musa Dahiru' },
  { id: 'isa',  username: 'Isa.ismail',       password: 'Isa7066@*',  name: 'Isa Ismail' }
];

const APP_BUILD = '2026.07.15-10-longpoll';
const SESSION_KEY = 'savingsSession_v1'; // session stays local to the device — that's correct, not shared data

/* ---------- Local live-synced mirror of the collections ----------
   Populated by onSnapshot listeners. Every read in this app reads
   from here; every write goes straight to Firestore. */
const state = {
  clients: [],
  savingsEntries: [],
  loans: [],
  loanPayments: [],
  messages: []
};

/* ---------- Session ---------- */
function getSession(){
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : { adminId: null, clientId: null };
}
function setSession(session){
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function clearSession(){
  localStorage.removeItem(SESSION_KEY);
}

/* ---------- Helpers ---------- */
function fmt(n){
  return '₦' + Number(n||0).toLocaleString('en-NG', { minimumFractionDigits: 0 });
}
function withTimeout(promise, ms=20000){
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(()=> reject(new Error(`Request timed out after ${ms/1000}s — your connection may be blocking the database. Try switching networks.`)), ms))
  ]);
}
function todayStr(){
  return new Date().toISOString().slice(0,10);
}
function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}
function getClient(id){ return state.clients.find(c => c.id === id); }

function availableSavings(clientId){
  return state.savingsEntries
    .filter(e => e.clientId === clientId)
    .reduce((sum,e) => sum + (e.type === 'deposit' ? e.amount : -e.amount), 0);
}
function totalSaved(clientId){
  return state.savingsEntries
    .filter(e => e.clientId === clientId && e.type === 'deposit')
    .reduce((s,e)=> s+e.amount, 0);
}
function clientLoans(clientId){ return state.loans.filter(l => l.clientId === clientId); }
function loanPaid(loanId){
  return state.loanPayments.filter(p => p.loanId === loanId).reduce((s,p)=>s+p.amount,0);
}
function loanBalance(loanId){
  const loan = state.loans.find(l=>l.id===loanId);
  return loan ? loan.principal - loanPaid(loanId) : 0;
}
function activeLoanTotal(clientId){
  return clientLoans(clientId).filter(l=>l.status==='active')
    .reduce((s,l)=> s + loanBalance(l.id), 0);
}
function clientMessages(clientId){
  return state.messages.filter(m => m.clientId === clientId).sort((a,b)=> a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
function unreadFromClientsCount(){
  return state.messages.filter(m => m.sender==='client' && !m.read).length;
}

/* ===========================================================
   PORTAL PAGE
=========================================================== */
function initPortal(){ /* static page, no logic required */ }

/* ===========================================================
   ADMIN LOGIN PAGE
=========================================================== */
function initAdminLogin(){
  const session = getSession();
  if(session.adminId){ window.location.href = 'admin-dashboard.html'; return; }

  const form = document.getElementById('adminLoginForm');
  form.addEventListener('submit', function(e){
    e.preventDefault();
    const username = document.getElementById('adminUsername').value.trim();
    const password = document.getElementById('adminPassword').value.trim();
    const errorBox = document.getElementById('adminLoginError');

    const admin = ADMIN_ACCOUNTS.find(a => a.username === username && a.password === password);
    if(!admin){
      errorBox.textContent = 'Incorrect username or password.';
      errorBox.classList.add('show');
      return;
    }
    errorBox.classList.remove('show');
    setSession({ adminId: admin.id, clientId: null });
    window.location.href = 'admin-dashboard.html';
  });
}

/* ===========================================================
   ADMIN DASHBOARD PAGE
=========================================================== */
let uiState = {
  entryType: 'deposit',
  entrySelectedClient: null,
  loanTab: 'new',
  loanSelectedClient: null,
  paySelectedClient: null,
  paySelectedLoan: null,
  clientDetailId: null,
  clientDetailTab: 'savings',
  adminThreadClientId: null,
  clientTab: 'savings',
  reportDateFilter: null
};

async function initAdminDashboard(){
  const session = getSession();
  if(!session.adminId){ window.location.href = 'admin-login.html'; return; }

  const admin = ADMIN_ACCOUNTS.find(a => a.id === session.adminId);
  document.getElementById('adminNameDisplay').textContent = admin ? admin.name : 'Admin';

  document.getElementById('logoutBtn').addEventListener('click', function(){
    unsubscribeAll();
    clearSession();
    window.location.href = 'admin-login.html';
  });

  showAdminView('admin-home');

  // Home action cards
  document.getElementById('cardOpenAccount').addEventListener('click', ()=> showAdminView('view-open-account'));
  document.getElementById('cardAddEntry').addEventListener('click', ()=> showAdminView('view-add-entry'));
  document.getElementById('cardLoan').addEventListener('click', ()=> showAdminView('view-loan'));
  document.getElementById('cardClients').addEventListener('click', ()=> { renderClientsHistory(); showAdminView('view-clients'); });
  document.getElementById('cardManageClients').addEventListener('click', ()=> { renderManageClients(); showAdminView('view-manage-clients'); });
  document.getElementById('cardReport').addEventListener('click', ()=> { initReportView(); showAdminView('view-report'); });
  document.getElementById('cardInbox').addEventListener('click', ()=> { renderInbox(); showAdminView('view-inbox'); });

  document.querySelectorAll('[data-back-home]').forEach(btn=>{
    btn.addEventListener('click', ()=> showAdminView('admin-home'));
  });

  // Open account
  document.getElementById('newClientName').addEventListener('input', function(){
    document.getElementById('newClientUsername').value = this.value.trim().toLowerCase().replace(/\s+/g,'.');
  });
  document.getElementById('openAccountForm').addEventListener('submit', function(e){
    e.preventDefault();
    createAccount();
  });

  // Add entry
  document.getElementById('entrySearch').addEventListener('input', function(){
    searchClients(this.value, 'entrySuggest', pickEntryClient);
  });
  document.getElementById('entryTypeDeposit').addEventListener('click', ()=> setEntryType('deposit'));
  document.getElementById('entryTypeWithdrawal').addEventListener('click', ()=> setEntryType('withdrawal'));
  document.getElementById('entryReviewBtn').addEventListener('click', reviewEntry);
  document.getElementById('entryCancelBtn').addEventListener('click', ()=>{
    document.getElementById('entryReview').classList.remove('show');
    document.getElementById('entryConfirmRow').style.display='none';
  });
  document.getElementById('entryConfirmBtn').addEventListener('click', confirmEntry);

  // Loan / payment
  document.getElementById('loanTabNew').addEventListener('click', ()=> setLoanTab('new'));
  document.getElementById('loanTabPay').addEventListener('click', ()=> setLoanTab('pay'));
  document.getElementById('loanSearch').addEventListener('input', function(){
    searchClients(this.value, 'loanSuggest', pickLoanClient);
  });
  document.getElementById('loanReviewBtn').addEventListener('click', reviewLoan);
  document.getElementById('loanCancelBtn').addEventListener('click', ()=>{
    document.getElementById('loanReview').classList.remove('show');
    document.getElementById('loanConfirmRow').style.display='none';
  });
  document.getElementById('loanConfirmBtn').addEventListener('click', confirmLoan);
  document.getElementById('paySearch').addEventListener('input', function(){
    searchClients(this.value, 'paySuggest', pickPayClient);
  });

  // Clients history
  document.getElementById('clientsHistorySearch').addEventListener('input', renderClientsHistory);
  document.getElementById('cdTabSavings').addEventListener('click', ()=> setClientDetailTab('savings'));
  document.getElementById('cdTabLoans').addEventListener('click', ()=> setClientDetailTab('loans'));
  document.getElementById('cdTabMsgs').addEventListener('click', ()=> setClientDetailTab('msgs'));
  document.getElementById('backToClientsBtn').addEventListener('click', ()=>{ renderClientsHistory(); showAdminView('view-clients'); });

  // Manage clients
  document.getElementById('manageClientsSearch').addEventListener('input', renderManageClients);
  document.getElementById('backToManageClientsBtn').addEventListener('click', ()=>{ renderManageClients(); showAdminView('view-manage-clients'); });
  document.getElementById('editClientForm').addEventListener('submit', function(e){
    e.preventDefault();
    saveClientEdit();
  });
  document.getElementById('deleteClientBtn').addEventListener('click', ()=>{
    document.getElementById('deleteClientConfirm').classList.add('show');
  });
  document.getElementById('deleteClientCancelBtn').addEventListener('click', ()=>{
    document.getElementById('deleteClientConfirm').classList.remove('show');
  });
  document.getElementById('deleteClientConfirmBtn').addEventListener('click', deleteClientNow);

  // Daily report
  document.getElementById('reportViewAllBtn').addEventListener('click', ()=> renderReport(null));
  document.getElementById('reportViewDayBtn').addEventListener('click', ()=> renderReport(document.getElementById('reportDate').value));
  document.getElementById('reportExportBtn').addEventListener('click', exportReportToExcel);

  // Inbox / thread
  document.getElementById('backToInboxBtn').addEventListener('click', ()=>{ renderInbox(); showAdminView('view-inbox'); });
  document.getElementById('adminReplySend').addEventListener('click', sendAdminReply);

  document.addEventListener('click', function(e){
    document.querySelectorAll('.suggest-list.show').forEach(box=>{
      if(!box.previousElementSibling.contains(e.target) && !box.contains(e.target)){
        box.classList.remove('show');
      }
    });
  });

  subscribeAdminData();
}

/* ---------- Live sync (Admin) ---------- */
let unsubscribers = [];
function unsubscribeAll(){
  unsubscribers.forEach(u => u());
  unsubscribers = [];
}
function subscribeAdminData(){
  unsubscribers.push(onSnapshot(colClients, snap=>{
    state.clients = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    onAdminDataChange();
  }));
  unsubscribers.push(onSnapshot(colSavings, snap=>{
    state.savingsEntries = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    onAdminDataChange();
  }));
  unsubscribers.push(onSnapshot(colLoans, snap=>{
    state.loans = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    onAdminDataChange();
  }));
  unsubscribers.push(onSnapshot(colPayments, snap=>{
    state.loanPayments = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    onAdminDataChange();
  }));
  unsubscribers.push(onSnapshot(colMessages, snap=>{
    state.messages = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    onAdminDataChange();
  }));
}
function onAdminDataChange(){
  refreshInboxBadge();
  if(document.getElementById('view-clients').classList.contains('active')) renderClientsHistory();
  if(document.getElementById('view-manage-clients').classList.contains('active')) renderManageClients();
  if(document.getElementById('view-report').classList.contains('active')) renderReport(document.getElementById('reportDate').value || null);
  if(document.getElementById('view-client-detail').classList.contains('active') && uiState.clientDetailId) setClientDetailTab(uiState.clientDetailTab);
  if(document.getElementById('view-inbox').classList.contains('active')) renderInbox();
  if(document.getElementById('view-thread').classList.contains('active') && uiState.adminThreadClientId) renderAdminChat();
  // keep any open client-picker balance readouts fresh
  if(uiState.entrySelectedClient && document.getElementById('entryPick').classList.contains('show')) pickEntryClient(uiState.entrySelectedClient, true);
  if(uiState.paySelectedClient && document.getElementById('payPick').classList.contains('show')) renderPayLoanList(uiState.paySelectedClient);
}

function showAdminView(viewId){
  document.querySelectorAll('#adminApp > .view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
  if(viewId === 'admin-home') refreshInboxBadge();
}

function refreshInboxBadge(){
  const n = unreadFromClientsCount();
  const badge = document.getElementById('inboxBadge');
  if(n>0){ badge.style.display='inline-block'; badge.textContent = n + ' new'; }
  else{ badge.style.display='none'; }
}

/* --- client search shared by Add Entry / Loan tabs --- */
function searchClients(query_, suggestId, onPick){
  const q = query_.trim().toLowerCase();
  const box = document.getElementById(suggestId);
  if(!q){ box.classList.remove('show'); box.innerHTML=''; return; }
  const matches = state.clients.filter(c => c.name.toLowerCase().includes(q) || c.idNumber.includes(q));
  if(matches.length===0){ box.classList.remove('show'); box.innerHTML=''; return; }
  box.innerHTML = matches.map(c =>
    `<div class="suggest-item" data-client-id="${c.id}">
       <div>${escapeHtml(c.name)}</div><div class="s-id">ID: ${escapeHtml(c.idNumber)}</div>
     </div>`
  ).join('');
  box.classList.add('show');
  box.querySelectorAll('.suggest-item').forEach(item=>{
    item.addEventListener('click', function(){
      onPick(this.dataset.clientId);
      box.classList.remove('show');
    });
  });
}

function pickEntryClient(clientId, silent){
  uiState.entrySelectedClient = clientId;
  const c = getClient(clientId);
  if(!c) return;
  if(!silent) document.getElementById('entrySearch').value = c.name;
  const pick = document.getElementById('entryPick');
  pick.innerHTML = `<div class="name">${escapeHtml(c.name)}</div>
    <div class="meta">ID: ${escapeHtml(c.idNumber)} · ${escapeHtml(c.phone||'')}</div>
    <div class="bal">Current available: ${fmt(availableSavings(c.id))}</div>`;
  pick.classList.add('show');
}
function setEntryType(type){
  uiState.entryType = type;
  document.getElementById('entryTypeDeposit').classList.toggle('active', type==='deposit');
  document.getElementById('entryTypeWithdrawal').classList.toggle('active', type==='withdrawal');
}
function reviewEntry(){
  const clientId = uiState.entrySelectedClient;
  const amount = Number(document.getElementById('entryAmount').value);
  if(!clientId || !amount) return;
  const client = getClient(clientId);
  const current = availableSavings(clientId);
  const newBal = uiState.entryType==='deposit' ? current+amount : current-amount;
  const review = document.getElementById('entryReview');
  review.innerHTML = `
    <div class="row"><span>Client</span><span>${escapeHtml(client.name)}</span></div>
    <div class="row"><span>Type</span><span>${uiState.entryType==='deposit'?'Deposit':'Withdrawal'}</span></div>
    <div class="row"><span>Amount</span><span>${fmt(amount)}</span></div>
    <div class="row total"><span>New Balance</span><span>${fmt(newBal)}</span></div>`;
  review.classList.add('show');
  document.getElementById('entryConfirmRow').style.display='flex';
}
function confirmEntry(){
  const clientId = uiState.entrySelectedClient;
  const amount = Number(document.getElementById('entryAmount').value);
  const note = document.getElementById('entryNote').value.trim();
  const session = getSession();
  const admin = ADMIN_ACCOUNTS.find(a => a.id === session.adminId);
  const adminName = admin ? admin.name : 'Admin';
  const btn = document.getElementById('entryConfirmBtn');
  btn.disabled = true; btn.textContent = 'Saving...';

  const balanceBefore = availableSavings(clientId);
  addDoc(colSavings, {
    clientId, type: uiState.entryType, amount, date: todayStr(), note, adminName
  }).then(()=>{
    document.getElementById('entryReview').classList.remove('show');
    document.getElementById('entryConfirmRow').style.display='none';
    const success = document.getElementById('entrySuccess');
    const newBal = uiState.entryType==='deposit' ? balanceBefore+amount : balanceBefore-amount;
    success.innerHTML = `Saved. ${escapeHtml(getClient(clientId).name)}'s available savings is now <strong>${fmt(newBal)}</strong>.`;
    success.classList.add('show');
    document.getElementById('entryAmount').value='';
    document.getElementById('entryNote').value='';
  }).catch(err=>{
    console.error(err);
    alert(`Could not save this entry — it was NOT recorded. Check your connection and try again.\n\n(${err.message})`);
  }).finally(()=>{
    btn.disabled = false; btn.textContent = 'Confirm & Save';
  });
}

/* --- Loan / Payment --- */
function setLoanTab(tab){
  uiState.loanTab = tab;
  document.getElementById('loanTabNew').classList.toggle('active', tab==='new');
  document.getElementById('loanTabPay').classList.toggle('active', tab==='pay');
  document.getElementById('loanPanelNew').classList.toggle('active', tab==='new');
  document.getElementById('loanPanelPay').classList.toggle('active', tab==='pay');
}
function pickLoanClient(clientId){
  uiState.loanSelectedClient = clientId;
  const c = getClient(clientId);
  if(!c) return;
  document.getElementById('loanSearch').value = c.name;
  const pick = document.getElementById('loanPick');
  pick.innerHTML = `<div class="name">${escapeHtml(c.name)}</div>
    <div class="meta">ID: ${escapeHtml(c.idNumber)}</div>
    <div class="bal">Current available: ${fmt(availableSavings(c.id))}</div>`;
  pick.classList.add('show');
}
function reviewLoan(){
  const clientId = uiState.loanSelectedClient;
  const principal = Number(document.getElementById('loanPrincipal').value);
  const rate = Number(document.getElementById('loanRate').value) || 0;
  const due = document.getElementById('loanDue').value;
  if(!clientId || !principal) return;
  const client = getClient(clientId);
  const totalRepay = principal + (principal*rate/100);
  const review = document.getElementById('loanReview');
  review.innerHTML = `
    <div class="row"><span>Client</span><span>${escapeHtml(client.name)}</span></div>
    <div class="row"><span>Principal</span><span>${fmt(principal)}</span></div>
    <div class="row"><span>Interest</span><span>${rate}%</span></div>
    <div class="row"><span>Due</span><span>${due||'—'}</span></div>
    <div class="row total"><span>Total Repayable</span><span>${fmt(totalRepay)}</span></div>`;
  review.classList.add('show');
  document.getElementById('loanConfirmRow').style.display='flex';
}
function confirmLoan(){
  const clientId = uiState.loanSelectedClient;
  const principal = Number(document.getElementById('loanPrincipal').value);
  const rate = Number(document.getElementById('loanRate').value) || 0;
  const due = document.getElementById('loanDue').value;
  const session = getSession();
  const admin = ADMIN_ACCOUNTS.find(a => a.id === session.adminId);
  const adminName = admin ? admin.name : 'Admin';
  const btn = document.getElementById('loanConfirmBtn');
  btn.disabled = true; btn.textContent = 'Saving...';

  addDoc(colLoans, { clientId, principal, rate, dueDate: due, status:'active', dateIssued: todayStr(), adminName }).then(()=>{
    document.getElementById('loanReview').classList.remove('show');
    document.getElementById('loanConfirmRow').style.display='none';
    const success = document.getElementById('loanSuccess');
    success.innerHTML = `Loan of <strong>${fmt(principal)}</strong> issued to ${escapeHtml(getClient(clientId).name)}.`;
    success.classList.add('show');
    document.getElementById('loanPrincipal').value='';
    document.getElementById('loanRate').value='';
    document.getElementById('loanDue').value='';
  }).catch(err=>{
    console.error(err);
    alert(`Could not issue this loan — it was NOT saved. Check your connection and try again.\n\n(${err.message})`);
  }).finally(()=>{
    btn.disabled = false; btn.textContent = 'Confirm & Save';
  });
}
function pickPayClient(clientId){
  uiState.paySelectedClient = clientId;
  const c = getClient(clientId);
  if(!c) return;
  document.getElementById('paySearch').value = c.name;
  const pick = document.getElementById('payPick');
  pick.innerHTML = `<div class="name">${escapeHtml(c.name)}</div><div class="meta">ID: ${escapeHtml(c.idNumber)}</div>`;
  pick.classList.add('show');
  renderPayLoanList(clientId);
}
function renderPayLoanList(clientId){
  const loans = clientLoans(clientId).filter(l=>l.status==='active');
  const box = document.getElementById('payLoanList');
  document.getElementById('payFormArea').innerHTML='';
  if(loans.length===0){ box.innerHTML = '<div class="empty-note">No active loans for this client.</div>'; return; }
  box.innerHTML = '<label style="display:block;font-size:0.78rem;font-weight:600;color:var(--ink-soft);margin-bottom:6px;">Select Loan</label>' +
    loans.map(l=>{
      const bal = loanBalance(l.id);
      return `<div class="action-card" style="margin-bottom:8px;" data-loan-id="${l.id}">
        <div class="txt"><strong>${fmt(l.principal)}</strong><span>Outstanding: ${fmt(bal)}</span></div>
      </div>`;
    }).join('');
  box.querySelectorAll('.action-card').forEach(card=>{
    card.addEventListener('click', function(){ selectPayLoan(this.dataset.loanId); });
  });
}
function selectPayLoan(loanId){
  uiState.paySelectedLoan = loanId;
  const bal = loanBalance(loanId);
  document.getElementById('payFormArea').innerHTML = `
    <div class="field"><label>Payment Amount (₦)</label><input type="number" id="payAmount"></div>
    <div class="hint" style="margin-bottom:10px;">Outstanding balance: ${fmt(bal)}</div>
    <button class="btn btn-client btn-block" id="payConfirmBtn">Confirm &amp; Save</button>`;
  document.getElementById('payConfirmBtn').addEventListener('click', ()=> confirmPayment(loanId));
}
function confirmPayment(loanId){
  const amount = Number(document.getElementById('payAmount').value);
  if(!amount) return;
  const session = getSession();
  const admin = ADMIN_ACCOUNTS.find(a => a.id === session.adminId);
  const adminName = admin ? admin.name : 'Admin';
  const btn = document.getElementById('payConfirmBtn');
  btn.disabled = true; btn.textContent = 'Saving...';
  const newBal = loanBalance(loanId) - amount;

  addDoc(colPayments, { loanId, amount, date: todayStr(), adminName }).then(async ()=>{
    if(newBal<=0){
      await updateDoc(doc(db,'loans',loanId), { status: 'paid' }).catch(err=>console.error(err));
    }
    const success = document.getElementById('paySuccess');
    success.innerHTML = `Payment recorded. Remaining balance: <strong>${fmt(Math.max(newBal,0))}</strong>.`;
    success.classList.add('show');
  }).catch(err=>{
    console.error(err);
    alert(`Could not record this payment — it was NOT saved. Check your connection and try again.\n\n(${err.message})`);
  }).finally(()=>{
    btn.disabled = false; btn.textContent = 'Confirm & Save';
  });
}

/* --- Manage Clients (edit / delete / recover login details) --- */
function renderManageClients(){
  const q = (document.getElementById('manageClientsSearch').value||'').trim().toLowerCase();
  const list = state.clients.filter(c=> c.name.toLowerCase().includes(q) || c.idNumber.includes(q));
  const box = document.getElementById('manageClientsList');
  if(list.length===0){ box.innerHTML = '<div class="empty-note">No clients found.</div>'; return; }
  box.innerHTML = list.map(c=>`
    <div class="action-card" data-client-id="${c.id}">
      <div class="txt"><strong>${escapeHtml(c.name)}</strong><span>Username: ${escapeHtml(c.username)} · ID: ${escapeHtml(c.idNumber)}</span></div>
    </div>`).join('');
  box.querySelectorAll('.action-card').forEach(card=>{
    card.addEventListener('click', function(){ openEditClient(this.dataset.clientId); });
  });
}
function openEditClient(clientId){
  const c = getClient(clientId);
  if(!c) return;
  uiState.editClientId = clientId;
  document.getElementById('editClientName').value = c.name || '';
  document.getElementById('editClientId').value = c.idNumber || '';
  document.getElementById('editClientPhone').value = c.phone || '';
  document.getElementById('editClientUsername').value = c.username || '';
  document.getElementById('editClientPassword').value = c.password || '';
  document.getElementById('editClientIdError').classList.remove('show');
  document.getElementById('editClientSuccess').classList.remove('show');
  document.getElementById('deleteClientConfirm').classList.remove('show');
  document.getElementById('deleteClientName').textContent = c.name;
  showAdminView('view-edit-client');
}
function saveClientEdit(){
  const clientId = uiState.editClientId;
  const name = document.getElementById('editClientName').value.trim();
  const idNumber = document.getElementById('editClientId').value.trim();
  const phone = document.getElementById('editClientPhone').value.trim();
  const username = document.getElementById('editClientUsername').value.trim();
  const password = document.getElementById('editClientPassword').value;
  const idErr = document.getElementById('editClientIdError');
  const submitBtn = document.querySelector('#editClientForm button[type=submit]');

  const dup = state.clients.some(c => c.id !== clientId && c.idNumber === idNumber);
  if(dup){ idErr.classList.add('show'); return; }
  idErr.classList.remove('show');

  submitBtn.disabled = true; submitBtn.textContent = 'Saving...';
  updateDoc(doc(db,'clients',clientId), { name, idNumber, phone, username, password }).then(()=>{
    const success = document.getElementById('editClientSuccess');
    success.textContent = 'Changes saved.';
    success.classList.add('show');
  }).catch(err=>{
    console.error(err);
    alert(`Could not save these changes — they were NOT applied. Check your connection and try again.\n\n(${err.message})`);
  }).finally(()=>{
    submitBtn.disabled = false; submitBtn.textContent = 'Save Changes';
  });
}
function deleteClientNow(){
  const clientId = uiState.editClientId;
  const btn = document.getElementById('deleteClientConfirmBtn');
  btn.disabled = true; btn.textContent = 'Deleting...';

  deleteDoc(doc(db,'clients',clientId)).catch(err=>{
    console.error(err);
    alert('This client could not be deleted permanently — please check your connection.');
  });
  document.getElementById('deleteClientConfirm').classList.remove('show');
  renderManageClients();
  showAdminView('view-manage-clients');
  btn.disabled = false; btn.textContent = 'Yes, Delete';
}

/* --- Daily Report --- */
function initReportView(){
  document.getElementById('reportDate').value = todayStr();
  renderReport(todayStr());
}
function buildReportRows(dateFilter){
  const rows = [];
  state.savingsEntries.forEach(e=>{
    const c = getClient(e.clientId);
    rows.push({ date: e.date, client: c ? c.name : '(deleted client)', type: e.type==='deposit'?'Deposit':'Withdrawal', amount: e.amount, credit: e.type==='deposit', by: e.adminName || '—' });
  });
  state.loans.forEach(l=>{
    const c = getClient(l.clientId);
    rows.push({ date: l.dateIssued || l.dueDate || '', client: c ? c.name : '(deleted client)', type: 'Loan Issued', amount: l.principal, credit: false, by: l.adminName || '—' });
  });
  state.loanPayments.forEach(p=>{
    const loan = state.loans.find(l=>l.id===p.loanId);
    const c = loan ? getClient(loan.clientId) : null;
    rows.push({ date: p.date, client: c ? c.name : '(deleted client)', type: 'Loan Payment', amount: p.amount, credit: true, by: p.adminName || '—' });
  });
  const filtered = dateFilter ? rows.filter(r => r.date === dateFilter) : rows;
  filtered.sort((a,b)=> b.date.localeCompare(a.date));
  return filtered;
}

function renderReport(dateFilter){
  const filtered = buildReportRows(dateFilter);
  uiState.reportDateFilter = dateFilter;

  document.getElementById('reportViewDayBtn').classList.toggle('btn-admin', !!dateFilter);
  document.getElementById('reportViewDayBtn').classList.toggle('btn-outline', !dateFilter);
  document.getElementById('reportViewAllBtn').classList.toggle('btn-admin', !dateFilter);
  document.getElementById('reportViewAllBtn').classList.toggle('btn-outline', !!dateFilter);

  const totalDeposits = filtered.filter(r=>r.type==='Deposit').reduce((s,r)=>s+r.amount,0);
  const totalWithdrawals = filtered.filter(r=>r.type==='Withdrawal').reduce((s,r)=>s+r.amount,0);
  const totalLoansIssued = filtered.filter(r=>r.type==='Loan Issued').reduce((s,r)=>s+r.amount,0);
  const totalPayments = filtered.filter(r=>r.type==='Loan Payment').reduce((s,r)=>s+r.amount,0);
  document.getElementById('reportSummary').innerHTML = `
    <div class="tile"><div class="t-label">Deposits</div><div class="t-val" style="color:var(--green-600)">${fmt(totalDeposits)}</div></div>
    <div class="tile"><div class="t-label">Withdrawals</div><div class="t-val" style="color:var(--red-600)">${fmt(totalWithdrawals)}</div></div>
    <div class="tile"><div class="t-label">Loans Issued</div><div class="t-val">${fmt(totalLoansIssued)}</div></div>
    <div class="tile"><div class="t-label">Loan Payments</div><div class="t-val" style="color:var(--green-600)">${fmt(totalPayments)}</div></div>`;

  const tbody = document.getElementById('reportTableBody');
  if(filtered.length===0){
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--ink-soft);padding:24px 10px;">No activity ${dateFilter ? 'on this date' : 'recorded yet'}.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(r=>`
    <tr>
      <td>${r.date}</td>
      <td>${escapeHtml(r.client)}</td>
      <td>${r.type}</td>
      <td class="${r.credit?'amt-credit':'amt-debit'}">${r.credit?'+':'–'} ${fmt(r.amount)}</td>
      <td>${escapeHtml(r.by)}</td>
    </tr>`).join('');
}

function exportReportToExcel(){
  const dateFilter = uiState.reportDateFilter;
  const rows = buildReportRows(dateFilter);
  if(rows.length===0){ alert('No activity to export for this view.'); return; }

  const sheetData = rows.map(r => ({
    Date: r.date,
    Client: r.client,
    Type: r.type,
    Amount: r.credit ? r.amount : -r.amount,
    'Handled By': r.by
  }));

  const totalDeposits = rows.filter(r=>r.type==='Deposit').reduce((s,r)=>s+r.amount,0);
  const totalWithdrawals = rows.filter(r=>r.type==='Withdrawal').reduce((s,r)=>s+r.amount,0);
  const totalLoansIssued = rows.filter(r=>r.type==='Loan Issued').reduce((s,r)=>s+r.amount,0);
  const totalPayments = rows.filter(r=>r.type==='Loan Payment').reduce((s,r)=>s+r.amount,0);
  sheetData.push({});
  sheetData.push({ Date: '', Client: '', Type: 'TOTAL Deposits', Amount: totalDeposits, 'Handled By': '' });
  sheetData.push({ Date: '', Client: '', Type: 'TOTAL Withdrawals', Amount: -totalWithdrawals, 'Handled By': '' });
  sheetData.push({ Date: '', Client: '', Type: 'TOTAL Loans Issued', Amount: -totalLoansIssued, 'Handled By': '' });
  sheetData.push({ Date: '', Client: '', Type: 'TOTAL Loan Payments', Amount: totalPayments, 'Handled By': '' });

  const ws = XLSX.utils.json_to_sheet(sheetData);
  ws['!cols'] = [ {wch:12}, {wch:22}, {wch:16}, {wch:14}, {wch:20} ];
  const wb = XLSX.utils.book_new();
  const sheetLabel = dateFilter ? dateFilter : 'All Time';
  XLSX.utils.book_append_sheet(wb, ws, sheetLabel.slice(0,31));

  const filenameDate = dateFilter || todayStr();
  XLSX.writeFile(wb, `Savings-Tracker-Report-${filenameDate}.xlsx`);
}

/* --- Clients History --- */
function renderClientsHistory(){
  const q = (document.getElementById('clientsHistorySearch').value||'').trim().toLowerCase();
  const list = state.clients.filter(c=> c.name.toLowerCase().includes(q) || c.idNumber.includes(q));
  const box = document.getElementById('clientsHistoryList');
  if(list.length===0){ box.innerHTML = '<div class="empty-note">No clients found.</div>'; return; }
  box.innerHTML = list.map(c=>{
    const active = clientLoans(c.id).filter(l=>l.status==='active');
    const loanTxt = active.length ? `Active loan: ${fmt(active.reduce((s,l)=>s+loanBalance(l.id),0))}` : 'No active loan';
    return `<div class="action-card" data-client-id="${c.id}">
      <div class="txt"><strong>${escapeHtml(c.name)}</strong><span>${loanTxt}</span></div>
      <div class="l-amt credit" style="margin-left:auto;">${fmt(availableSavings(c.id))}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('.action-card').forEach(card=>{
    card.addEventListener('click', function(){ openClientDetail(this.dataset.clientId); });
  });
}
function openClientDetail(clientId){
  uiState.clientDetailId = clientId;
  document.getElementById('clientDetailName').textContent = getClient(clientId).name;
  setClientDetailTab('savings');
  showAdminView('view-client-detail');
}
function setClientDetailTab(tab){
  uiState.clientDetailTab = tab;
  document.getElementById('cdTabSavings').classList.toggle('active', tab==='savings');
  document.getElementById('cdTabLoans').classList.toggle('active', tab==='loans');
  document.getElementById('cdTabMsgs').classList.toggle('active', tab==='msgs');
  document.getElementById('cdPanelSavings').classList.toggle('active', tab==='savings');
  document.getElementById('cdPanelLoans').classList.toggle('active', tab==='loans');
  document.getElementById('cdPanelMsgs').classList.toggle('active', tab==='msgs');
  const clientId = uiState.clientDetailId;
  if(tab==='savings') document.getElementById('cdPanelSavings').innerHTML = renderSavingsLedgerHtml(clientId);
  else if(tab==='loans') document.getElementById('cdPanelLoans').innerHTML = renderLoansHtml(clientId);
  else document.getElementById('cdPanelMsgs').innerHTML = renderThreadPreviewHtml(clientId);
}
function renderSavingsLedgerHtml(clientId){
  const entries = state.savingsEntries.filter(e=>e.clientId===clientId).sort((a,b)=> b.date.localeCompare(a.date));
  if(entries.length===0) return '<div class="empty-note">No savings entries yet.</div>';
  return '<ul class="ledger-list">' + entries.map(e=>`
    <li class="ledger-row">
      <div class="l-main"><strong>${e.type==='deposit'?'Deposit':'Withdrawal'}</strong><span>${e.date}${e.note? ' · '+escapeHtml(e.note):''}</span></div>
      <div class="l-amt ${e.type==='deposit'?'credit':'debit'}">${e.type==='deposit'?'+':'–'} ${fmt(e.amount)}</div>
    </li>`).join('') + '</ul>';
}
function renderLoansHtml(clientId){
  const loans = clientLoans(clientId);
  if(loans.length===0) return '<div class="empty-note">No loans on record.</div>';
  return loans.map(l=>{
    const paid = loanPaid(l.id);
    const pct = Math.min(100, Math.round((paid/l.principal)*100));
    return `<div class="loan-card">
      <div class="lc-top">
        <div><div class="lc-amt">${fmt(l.principal)}</div></div>
        <span class="status-chip ${l.status==='paid'?'paid':''}">${l.status}</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="lc-due">Repaid ${fmt(paid)} of ${fmt(l.principal)} · Due ${l.dueDate||'—'}</div>
    </div>`;
  }).join('');
}
function renderThreadPreviewHtml(clientId){
  const msgs = clientMessages(clientId);
  if(msgs.length===0) return '<div class="empty-note">No messages with this client.</div>';
  return '<div class="chat-area" style="max-height:260px;">' + msgs.map(m=>`
    <div class="bubble ${m.sender==='client'?'from-other':'from-self'}">${escapeHtml(m.text)}<span class="b-time">${m.date}</span></div>
  `).join('') + '</div>';
}

/* --- Inbox --- */
function renderInbox(){
  refreshInboxBadge();
  const byClient = {};
  state.messages.forEach(m=>{
    if(!byClient[m.clientId] || byClient[m.clientId].date < m.date) byClient[m.clientId] = m;
  });
  const rows = Object.values(byClient).sort((a,b)=> b.date.localeCompare(a.date));
  const box = document.getElementById('inboxList');
  if(rows.length===0){ box.innerHTML = '<div class="empty-note">No messages yet.</div>'; return; }
  box.innerHTML = rows.map(m=>{
    const client = getClient(m.clientId);
    if(!client) return '';
    const hasUnread = state.messages.some(x=>x.clientId===m.clientId && x.sender==='client' && !x.read);
    return `<div class="thread-item" data-client-id="${m.clientId}">
      <div class="dot ${hasUnread?'':'read'}"></div>
      <div class="tm">
        <div class="tname">${escapeHtml(client.name)}</div>
        <div class="tprev">${escapeHtml(m.text)}</div>
        <div class="ttime">${m.date}</div>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('.thread-item').forEach(item=>{
    item.addEventListener('click', function(){ openAdminThread(this.dataset.clientId); });
  });
}
async function openAdminThread(clientId){
  uiState.adminThreadClientId = clientId;
  document.getElementById('adminThreadName').textContent = getClient(clientId).name;
  renderAdminChat();
  showAdminView('view-thread');
  const unread = state.messages.filter(m=>m.clientId===clientId && m.sender==='client' && !m.read);
  for(const m of unread){
    try{ await updateDoc(doc(db,'messages',m.id), { read: true }); }catch(err){ console.error(err); }
  }
}
function renderAdminChat(){
  const clientId = uiState.adminThreadClientId;
  const msgs = clientMessages(clientId);
  const area = document.getElementById('adminChatArea');
  area.innerHTML = msgs.map(m=>`
    <div class="bubble ${m.sender==='client'?'from-other':'from-self'}">${escapeHtml(m.text)}<span class="b-time">${m.date}</span></div>
  `).join('');
  area.scrollTop = area.scrollHeight;
}
function sendAdminReply(){
  const text = document.getElementById('adminReplyText').value.trim();
  if(!text) return;
  const btn = document.getElementById('adminReplySend');
  addDoc(colMessages, { clientId: uiState.adminThreadClientId, sender:'admin', text, date: todayStr(), read:true }).catch(err=>{
    console.error(err);
    alert('This message could not be sent permanently — please check your connection.');
  });
  document.getElementById('adminReplyText').value='';
}

/* --- Open Account --- */
async function createAccount(){
  const name = document.getElementById('newClientName').value.trim();
  const idNumber = document.getElementById('newClientId').value.trim();
  const phone = document.getElementById('newClientPhone').value.trim();
  const username = document.getElementById('newClientUsername').value.trim();
  const password = document.getElementById('newClientPassword').value;
  const idErr = document.getElementById('newClientIdError');
  const submitBtn = document.querySelector('#openAccountForm button[type=submit]');

  if(!name || !idNumber || !username || !password) return;

  // Duplicate check reads from the already-synced local client list —
  // no extra network round-trip needed, since Manage Clients/Clients
  // History already keep state.clients live via onSnapshot.
  const dup = state.clients.some(c => c.idNumber === idNumber);
  if(dup){
    idErr.classList.add('show');
    return;
  }
  idErr.classList.remove('show');

  submitBtn.disabled = true; submitBtn.textContent = 'Saving...';
  try{
    await withTimeout(addDoc(colClients, { username, idNumber, password, name, phone }));
    const box = document.getElementById('createSuccess');
    box.innerHTML = `Account created for <strong>${escapeHtml(name)}</strong>.<br>
      Username: <strong>${escapeHtml(username)}</strong> · ID: <strong>${escapeHtml(idNumber)}</strong><br>
      They can log in now with the password you set.`;
    box.classList.add('show');
    document.getElementById('openAccountForm').reset();
  }catch(err){
    console.error(err);
    alert(`Could not save this account — it was NOT created. Check your connection and try again.\n\n(${err.message})`);
  }finally{
    submitBtn.disabled = false; submitBtn.textContent = 'Create Account';
  }
}

/* ===========================================================
   CLIENT LOGIN PAGE
=========================================================== */
function initClientLogin(){
  const session = getSession();
  if(session.clientId){ window.location.href = 'client-dashboard.html'; return; }

  const form = document.getElementById('clientLoginForm');
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    const username = document.getElementById('clientUsername').value.trim();
    const idNumber = document.getElementById('clientIdNumber').value.trim();
    const password = document.getElementById('clientPassword').value;
    const errorBox = document.getElementById('clientLoginError');
    const submitBtn = form.querySelector('button[type=submit]');
    submitBtn.disabled = true; submitBtn.textContent = 'Checking...';

    try{
      const q = query(colClients, where('username','==',username), where('idNumber','==',idNumber), where('password','==',password));
      const snap = await getDocs(q);
      if(snap.empty){
        // TEMPORARY DIAGNOSTIC — look this client up by ID number alone,
        // and show exactly what's stored vs what was typed, so we can see
        // the mismatch directly without needing the Firestore console.
        let diagnostic = '';
        try{
          const idOnlySnap = await getDocs(query(colClients, where('idNumber','==',idNumber)));
          if(idOnlySnap.empty){
            diagnostic = `No client found with ID number "${idNumber}" at all.`;
          }else{
            const found = idOnlySnap.docs[0].data();
            diagnostic = `Found a client with that ID. Stored username: "${found.username}" (you typed: "${username}"). Stored password: "${found.password}" (you typed: "${password}").`;
          }
        }catch(diagErr){ diagnostic = 'Diagnostic lookup also failed: ' + diagErr.message; }

        errorBox.innerHTML = 'Incorrect username, ID number, or password.<br><br><strong>Diagnostic:</strong> ' + escapeHtml(diagnostic);
        errorBox.classList.add('show');
        submitBtn.disabled = false; submitBtn.textContent = 'Log In';
        return;
      }
      errorBox.classList.remove('show');
      setSession({ adminId: null, clientId: snap.docs[0].id });
      window.location.href = 'client-dashboard.html';
    }catch(err){
      console.error(err);
      errorBox.textContent = 'Could not reach the database. Check your connection and try again.';
      errorBox.classList.add('show');
      submitBtn.disabled = false; submitBtn.textContent = 'Log In';
    }
  });
}

/* ===========================================================
   CLIENT DASHBOARD PAGE
=========================================================== */
async function initClientDashboard(){
  const session = getSession();
  if(!session.clientId){ window.location.href = 'client-login.html'; return; }

  document.getElementById('logoutBtn').addEventListener('click', function(){
    unsubscribeAll();
    clearSession();
    window.location.href = 'client-login.html';
  });
  document.getElementById('clTabSavings').addEventListener('click', ()=> setClientTab('savings'));
  document.getElementById('clTabLoans').addEventListener('click', ()=> setClientTab('loans'));
  document.getElementById('clTabMsg').addEventListener('click', ()=> setClientTab('msg'));

  document.querySelectorAll('.preset-chip').forEach(chip=>{
    chip.addEventListener('click', function(){ fillPreset(this.dataset.preset); });
  });
  document.getElementById('clientMsgSend').addEventListener('click', sendClientMessage);

  subscribeClientData(session.clientId);
}

function subscribeClientData(clientId){
  unsubscribers.push(onSnapshot(query(colSavings, where('clientId','==',clientId)), snap=>{
    state.savingsEntries = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    onClientDataChange();
  }));
  unsubscribers.push(onSnapshot(query(colLoans, where('clientId','==',clientId)), snap=>{
    state.loans = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    onClientDataChange();
  }));
  unsubscribers.push(onSnapshot(colPayments, snap=>{
    state.loanPayments = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    onClientDataChange();
  }));
  unsubscribers.push(onSnapshot(query(colMessages, where('clientId','==',clientId)), snap=>{
    state.messages = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    onClientDataChange();
  }));
}
function onClientDataChange(){
  renderClientDashboard();
}

function renderClientDashboard(){
  const session = getSession();
  const client = getClient(session.clientId);
  if(!client){
    // client doc not loaded yet (first snapshot may arrive before we've fetched the name) — fetch once
    getDoc(doc(db,'clients',session.clientId)).then(snap=>{
      if(snap.exists()){
        state.clients = [{ id: snap.id, ...snap.data() }];
        renderClientDashboard();
      }
    });
    return;
  }
  document.getElementById('clientNameDisplay').textContent = client.name.split(' ')[0];
  document.getElementById('clientHeroDate').textContent = 'Today, ' + new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  document.getElementById('clientAvailable').textContent = fmt(availableSavings(client.id));
  document.getElementById('clientActiveLoan').textContent = fmt(activeLoanTotal(client.id));
  document.getElementById('clientTotalSaved').textContent = fmt(totalSaved(client.id));
  setClientTab(uiState.clientTab);
}

function setClientTab(tab){
  uiState.clientTab = tab;
  document.getElementById('clTabSavings').classList.toggle('active', tab==='savings');
  document.getElementById('clTabLoans').classList.toggle('active', tab==='loans');
  document.getElementById('clTabMsg').classList.toggle('active', tab==='msg');
  document.getElementById('clPanelSavings').classList.toggle('active', tab==='savings');
  document.getElementById('clPanelLoans').classList.toggle('active', tab==='loans');
  document.getElementById('clPanelMsg').classList.toggle('active', tab==='msg');

  const session = getSession();
  const clientId = session.clientId;
  if(tab==='savings'){
    document.getElementById('clSavingsListWrap').innerHTML = renderSavingsLedgerHtml(clientId);
  } else if(tab==='loans'){
    document.getElementById('clLoansListWrap').innerHTML = renderLoansHtml(clientId);
  } else {
    renderClientChat();
  }
}

function fillPreset(key){
  const presets = {
    loan: 'Hi, I have a question about my loan — ',
    deposit: "Hi, I made a deposit that isn't showing in my savings history yet. ",
    other: ''
  };
  const box = document.getElementById('clientMsgText');
  box.value = presets[key] || '';
  box.focus();
}
function renderClientChat(){
  const session = getSession();
  const msgs = clientMessages(session.clientId);
  const area = document.getElementById('clientChatArea');
  if(msgs.length===0){ area.innerHTML = '<div class="empty-note">No messages yet — say hello to your admin.</div>'; return; }
  area.innerHTML = msgs.map(m=>`
    <div class="bubble ${m.sender==='client'?'from-self':'from-other'}">${escapeHtml(m.text)}<span class="b-time">${m.date}</span></div>
  `).join('');
  area.scrollTop = area.scrollHeight;
}
function sendClientMessage(){
  const text = document.getElementById('clientMsgText').value.trim();
  if(!text) return;
  const session = getSession();
  addDoc(colMessages, { clientId: session.clientId, sender:'client', text, date: todayStr(), read:false }).catch(err=>{
    console.error(err);
    alert('This message could not be sent permanently — please check your connection.');
  });
  document.getElementById('clientMsgText').value='';
}

/* ===========================================================
   PWA — Service Worker registration
=========================================================== */
function registerServiceWorker(){
  if('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('service-worker.js')
        .catch(err => console.warn('Service worker registration failed:', err));
    });
  }
}

/* ===========================================================
   Page switchboard
=========================================================== */
function showFatalErrorBanner(message){
  if(document.getElementById('fatalErrorBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'fatalErrorBanner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#C0392B;color:#fff;padding:12px 16px;font-size:0.8rem;z-index:9999;font-family:sans-serif;';
  banner.textContent = 'Something went wrong loading this page: ' + message;
  document.body.prepend(banner);
}
window.addEventListener('error', function(e){ showFatalErrorBanner(e.message || 'Unknown error'); });
window.addEventListener('unhandledrejection', function(e){ showFatalErrorBanner((e.reason && e.reason.message) || e.reason || 'Unknown error'); });

function renderVersionStamp(){
  const el = document.createElement('div');
  el.textContent = 'v' + APP_BUILD;
  el.style.cssText = 'position:fixed;bottom:4px;right:6px;font-size:0.6rem;color:#9aa5ad;background:rgba(255,255,255,0.85);padding:2px 6px;border-radius:4px;z-index:9998;font-family:monospace;pointer-events:none;';
  document.body.appendChild(el);
}

document.addEventListener('DOMContentLoaded', function(){
  registerServiceWorker();
  renderVersionStamp();
  const page = document.body.dataset.page;
  switch(page){
    case 'portal': initPortal(); break;
    case 'admin-login': initAdminLogin(); break;
    case 'admin-dashboard': initAdminDashboard(); break;
    case 'client-login': initClientLogin(); break;
    case 'client-dashboard': initClientDashboard(); break;
  }
});
