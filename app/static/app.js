const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const hdVideoConstraints = {width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}};
const state = {
  meeting: null, participantId: null, displayName: "Guest", ws: null,
  localStream: null, screenStream: null, peers: new Map(), peerNames: new Map(),
  muted: false, cameraOff: false, screenSharing: false, recorder: null,
  recordingChunks: [], recordingStarted: 0, recordingTimer: null, chat: [],
  joined: false, raisedHand: false, focus: false, mediaReady: false,
  startingMeeting: false
};
const controlIcons = {
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9v5a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-5.8-1M5 10v2a7 7 0 0 0 11.6 5.3M19 10v2a7 7 0 0 1-.4 2.3M12 19v3m-4 0h8M3 3l18 18"/></svg>',
  cameraOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 10l5-3v10l-5-3M3 6h12a1 1 0 0 1 1 1v2M16 15v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7m-1-6 20 20"/></svg>',
  recording: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>',
  recordStop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>'
};
const backdrop = $("#modalBackdrop"), modalContent = $("#modalContent");
const meetingShell = $("#meetingShell");
const rtcConfig = {iceServers:[{urls:"stun:stun.l.google.com:19302"}]};
const heroDemoVideo = $(".hero-demo-video");
const reducedMotionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
if (heroDemoVideo && reducedMotionPreference.matches) heroDemoVideo.pause();
reducedMotionPreference.addEventListener("change", event => {
  if (!heroDemoVideo) return;
  if (event.matches) heroDemoVideo.pause();
  else heroDemoVideo.play().catch(error => console.warn("Homepage video playback could not start:", error));
});
const highlightsCarousel = $("#highlightsCarousel");
if (highlightsCarousel) {
  const highlightSlides = $$(".highlight-slide", highlightsCarousel);
  const highlightDots = $$(".highlight-dot", highlightsCarousel);
  const highlightPosition = $("#highlightPosition");
  const highlightPause = $("#highlightPause");
  let activeHighlight = 0;
  let highlightTimer = null;
  let highlightsPaused = false;
  let highlightsHovered = false;
  let highlightsFocused = false;

  function syncHighlightTimer() {
    window.clearInterval(highlightTimer);
    highlightTimer = null;
    if (highlightsPaused || highlightsHovered || highlightsFocused || document.hidden || reducedMotionPreference.matches) return;
    highlightTimer = window.setInterval(() => showHighlight(activeHighlight + 1), 6500);
  }
  function showHighlight(index) {
    activeHighlight = (index + highlightSlides.length) % highlightSlides.length;
    highlightSlides.forEach((slide, slideIndex) => {
      const isActive = slideIndex === activeHighlight;
      slide.hidden = !isActive;
      slide.setAttribute("aria-hidden", String(!isActive));
      highlightDots[slideIndex].classList.toggle("is-active", isActive);
      if (isActive) highlightDots[slideIndex].setAttribute("aria-current", "true");
      else highlightDots[slideIndex].removeAttribute("aria-current");
    });
    highlightPosition.textContent = `${String(activeHighlight + 1).padStart(2, "0")} / ${String(highlightSlides.length).padStart(2, "0")}`;
    syncHighlightTimer();
  }

  highlightDots.forEach((dot, index) => dot.addEventListener("click", () => showHighlight(index)));
  $("#highlightPrevious").addEventListener("click", () => showHighlight(activeHighlight - 1));
  $("#highlightNext").addEventListener("click", () => showHighlight(activeHighlight + 1));
  highlightPause.addEventListener("click", () => {
    highlightsPaused = !highlightsPaused;
    highlightPause.innerHTML = highlightsPaused ? "▶ <span>Play</span>" : "Ⅱ <span>Pause</span>";
    highlightPause.setAttribute("aria-label", highlightsPaused ? "Resume automatic slides" : "Pause automatic slides");
    highlightPause.setAttribute("aria-pressed", String(highlightsPaused));
    syncHighlightTimer();
  });
  highlightsCarousel.addEventListener("pointerenter", () => {
    highlightsHovered = true;
    syncHighlightTimer();
  });
  highlightsCarousel.addEventListener("pointerleave", () => {
    highlightsHovered = false;
    syncHighlightTimer();
  });
  highlightsCarousel.addEventListener("focusin", () => {
    highlightsFocused = true;
    syncHighlightTimer();
  });
  highlightsCarousel.addEventListener("focusout", event => {
    if (highlightsCarousel.contains(event.relatedTarget)) return;
    highlightsFocused = false;
    syncHighlightTimer();
  });
  document.addEventListener("visibilitychange", syncHighlightTimer);
  reducedMotionPreference.addEventListener("change", syncHighlightTimer);
  syncHighlightTimer();
}

function toast(message) {
  const el = document.createElement("div"); el.className="toast"; el.textContent=message;
  $("#toastRegion").append(el); setTimeout(()=>el.remove(),3500);
}
function announce(message) {
  toast(message);
  if (!("speechSynthesis" in window) || typeof window.SpeechSynthesisUtterance !== "function") return;
  try {
    window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(message));
  } catch (error) {
    console.warn("Voice announcement could not be played:", error);
  }
}
function setControlIcon(button, icon, label) {
  button.querySelector("span").innerHTML = icon;
  button.title = label;
  button.setAttribute("aria-label", label);
}
async function api(url, options={}) {
  const res = await fetch(url,{headers:{"Content-Type":"application/json"},...options});
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
  return data;
}
function openModal(html){modalContent.innerHTML=html;backdrop.hidden=false;}
function closeModal(){backdrop.hidden=true;modalContent.innerHTML="";}
$("#closeModal").addEventListener("click",closeModal);
backdrop.addEventListener("click",e=>{if(e.target===backdrop)closeModal();});
function joinForm(code=""){
  openModal(`<div class="section-kicker">WELCOME TO MEETFLOW</div><h2 id="modalTitle">Join a meeting</h2><p>Enter the meeting code and the name you want others to see.</p><form id="joinForm"><div class="form-field"><label for="joinName">Your display name</label><input id="joinName" maxlength="60" required placeholder="e.g. Navya" autocomplete="name"></div><div class="form-field"><label for="joinCode">Meeting code or link</label><input id="joinCode" value="${escapeAttr(code)}" required placeholder="e.g. A1B2C3D4"></div><button class="btn btn-primary" type="submit">Continue to meeting →</button></form>`);
  $("#joinForm").addEventListener("submit",async e=>{
    e.preventDefault();const name=$("#joinName").value.trim(), raw=$("#joinCode").value.trim();
    const match=raw.match(/[A-Z0-9]{8}/i); if(!match){toast("Enter a valid 8-character meeting code or link.");return;}
    try{const m=await api(`/api/meetings/${match[0].toUpperCase()}`);closeModal();await enterLobby(m,name);}catch(err){toast(err.message);}
  });
}
function scheduleForm(){
 openModal(`<div class="section-kicker">PLAN AHEAD</div><h2 id="modalTitle">Schedule a meeting</h2><p>Create a meeting and share the invite link when you're ready.</p><form id="scheduleForm">
 <div class="form-field"><label>Meeting title</label><input id="schedTitle" required maxlength="160" placeholder="Weekly team sync"></div>
 <div class="form-field"><label>Description / agenda (optional)</label><textarea id="schedDesc" rows="2" maxlength="4000" placeholder="What would you like to discuss?"></textarea></div>
 <div class="form-field"><label>Date and time</label><input id="schedDate" type="datetime-local" required></div>
 <div class="form-field"><label>Duration</label><select id="schedDuration"><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="45">45 minutes</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option></select></div>
 <button class="btn btn-primary" type="submit">Save scheduled meeting →</button></form>`);
 const date=new Date(Date.now()+3600000);date.setMinutes(Math.ceil(date.getMinutes()/15)*15,0,0);$("#schedDate").value=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
 $("#scheduleForm").addEventListener("submit",async e=>{e.preventDefault();try{const dateVal=new Date($("#schedDate").value);if(dateVal<=new Date())throw new Error("Choose a future date and time.");const m=await api("/api/meetings",{method:"POST",body:JSON.stringify({title:$("#schedTitle").value.trim(),description:$("#schedDesc").value.trim(),scheduled_at:dateVal.toISOString(),duration_minutes:Number($("#schedDuration").value)})});closeModal();toast("Meeting scheduled and saved.");await loadMeetings();openCreated(m,true);}catch(err){toast(err.message);}});
}
function escapeHtml(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function escapeAttr(s=""){return escapeHtml(s).replace(/`/g,"&#96;");}
function preferredMediaConstraints(constraints){
 return {...constraints,video:constraints.video?{...hdVideoConstraints,...(typeof constraints.video==="object"?constraints.video:{})}:false};
}
async function captureMedia(constraints){
 try{return await navigator.mediaDevices.getUserMedia(preferredMediaConstraints(constraints));}
 catch(error){
  if(!constraints.video||!["OverconstrainedError","TypeError"].includes(error.name))throw error;
  console.warn("Preferred HD camera settings are unavailable; retrying with browser defaults.",error);
  toast("Your camera doesn't support the preferred HD settings. Using its best available quality.");
  return navigator.mediaDevices.getUserMedia({...constraints,video:true});
 }
}
async function preferVideoResolution(sender){
 try{
  const parameters=sender.getParameters();
  if(!("degradationPreference" in parameters))return;
  parameters.degradationPreference="maintain-resolution";
  await sender.setParameters(parameters);
 }catch(error){
  console.warn("Could not prioritize video resolution for this connection.",error);
 }
}
function setMeetingLaunchStatus(title,message){
 $("#meetingLaunchTitle").textContent=title;
 $("#meetingLaunchMessage").textContent=message;
}
function hideMeetingLaunch(){
 $("#meetingLaunch").hidden=true;
}
async function createMeeting(){
 if(state.startingMeeting)return;
 state.startingMeeting=true;
 const startedAt=performance.now();
 setMeetingLaunchStatus("Creating your meeting","Setting up your Meetflow room.");
 $("#meetingLaunch").hidden=false;
 $$("#startMeeting,#startMeeting2").forEach(button=>{button.disabled=true;button.setAttribute("aria-busy","true");});
 try{
  const m=await api("/api/meetings",{method:"POST",body:JSON.stringify({title:"Quick Meetflow meeting",description:""})});
  setMeetingLaunchStatus("Preparing your meeting","Review your terms and device settings before joining.");
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,900-(performance.now()-startedAt))));
  hideMeetingLaunch();
  void loadMeetings();
  enterLobby(m,"Guest");
 }catch(e){hideMeetingLaunch();toast(`Couldn't start your meeting: ${e.message}`);}
 finally{
  state.startingMeeting=false;
  $$("#startMeeting,#startMeeting2").forEach(button=>{button.disabled=false;button.removeAttribute("aria-busy");});
 }
}
function openCreated(m,scheduled){
 const inviteUrl=`${location.origin}/?meeting=${m.code}`;
 openModal(`<div class="section-kicker">${scheduled?"MEETING SCHEDULED":"YOUR ROOM IS READY"}</div><h2 id="modalTitle">${escapeHtml(m.title)}</h2><p>${scheduled?"Your meeting has been saved.":"Share this invite link with the people you want to meet."}</p><div class="form-field"><label>Meeting code</label><input readonly value="${m.code}" id="createdCode"></div><div class="form-field"><label>Invitation link</label><input readonly value="${inviteUrl}" id="createdLink"></div><button class="btn btn-primary" id="copyCreated">Copy invitation link</button><button class="btn btn-secondary" id="enterCreated">${scheduled?"Open meeting":"Join meeting now"} →</button>`);
 $("#copyCreated").onclick=async()=>{await navigator.clipboard.writeText(inviteUrl).catch(()=>{});toast("Invite link copied if clipboard permission is available.");};
 $("#enterCreated").onclick=async()=>{closeModal();joinForm(m.code);};
}
$("#startMeeting").onclick=()=>createMeeting();$("#startMeeting2").onclick=()=>createMeeting();
$("#openJoin").onclick=()=>joinForm();$("#openJoin2").onclick=()=>joinForm();$("#openSchedule").onclick=scheduleForm;
$("#refreshMeetings").onclick=loadMeetings;
$("#signOut").onclick=async()=>{try{await api("/api/auth/logout",{method:"POST"});location.replace("/");}catch(error){toast(`Couldn't sign out: ${error.message}`);}};

let cachedMeetings=[];
let activeMeetingFilter="all";
function renderMeetings(){
 const container=$("#meetingList");
 const query=$("#meetingSearch").value.trim().toLowerCase();
 const meetings=cachedMeetings.filter(meeting=>{
  const matchesFilter=activeMeetingFilter==="all"||(activeMeetingFilter==="scheduled"?!!meeting.scheduled_at:!meeting.scheduled_at);
  const searchable=[meeting.title,meeting.description,meeting.code].join(" ").toLowerCase();
  return matchesFilter&&searchable.includes(query);
 });
 if(!query){
  container.innerHTML=`<div class="empty-state"><b>Search your meetings</b><p>Enter a title, agenda, or meeting code to find a meeting.</p></div>`;
  return;
 }
 if(!meetings.length){
  container.innerHTML=`<div class="empty-state"><b>No meetings match</b><p>Try a different search or filter.</p></div>`;
  return;
 }
 container.innerHTML=meetings.map(m=>`<article class="meeting-card"><h3>${escapeHtml(m.title)}</h3><p>${escapeHtml(m.description||"A Meetflow meeting")}</p><div class="meeting-meta">${m.scheduled_at?`◷ ${new Date(m.scheduled_at).toLocaleString()}`:"Instant meeting"} · ${m.duration_minutes} min · <b>${escapeHtml(m.code)}</b></div><div class="meeting-actions"><button class="btn btn-primary small" data-join="${m.code}">Join →</button><button class="btn btn-secondary small" data-copy="${m.code}">Copy invite</button></div></article>`).join("");
 $$('[data-join]',container).forEach(button=>button.onclick=()=>joinForm(button.dataset.join));
 $$('[data-copy]',container).forEach(button=>button.onclick=async()=>{try{await navigator.clipboard.writeText(`${location.origin}/?meeting=${button.dataset.copy}`);toast("Invitation copied.");}catch{toast("Copy unavailable; open the meeting to copy its link.");}});
}
function updateMeetingInsights(meetings){
 const upcoming=meetings.filter(meeting=>meeting.scheduled_at&&new Date(meeting.scheduled_at)>new Date()).sort((a,b)=>new Date(a.scheduled_at)-new Date(b.scheduled_at));
 $("#savedMeetingCount").textContent=meetings.length;
 $("#upcomingMeetingCount").textContent=upcoming.length;
 $("#instantMeetingCount").textContent=meetings.filter(meeting=>!meeting.scheduled_at).length;
 $("#nextMeetingTitle").textContent=upcoming[0]?.title||"Nothing scheduled";
 $("#nextMeetingTime").textContent=upcoming[0]?new Date(upcoming[0].scheduled_at).toLocaleString():"Plan your next conversation";
}
async function loadMeetings(){
 try{cachedMeetings=await api("/api/meetings");updateMeetingInsights(cachedMeetings);renderMeetings();}
 catch(e){$("#meetingList").innerHTML=`<div class="empty-state"><b>Couldn't load meetings</b><p>${escapeHtml(e.message)}</p></div>`;}
}
$("#meetingSearch").addEventListener("input",renderMeetings);
$$('[data-meeting-filter]').forEach(button=>button.addEventListener("click",()=>{
 activeMeetingFilter=button.dataset.meetingFilter;
 $$('[data-meeting-filter]').forEach(filter=>{
  const active=filter===button;
  filter.classList.toggle("is-active",active);
  filter.setAttribute("aria-pressed",String(active));
 });
 renderMeetings();
}));
loadMeetings();

function makeId(){return crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`;}
async function enterLobby(meeting,name){
 state.meeting=meeting;state.displayName=name||"Guest";state.participantId=makeId();
 openModal(`<div class="section-kicker">MEETING LOBBY</div><h2 id="modalTitle">Ready to join?</h2><p>${escapeHtml(meeting.title)} · ${escapeHtml(meeting.code)}</p><div class="form-field"><label for="lobbyName">Display name</label><input id="lobbyName" maxlength="60" value="${escapeAttr(state.displayName)}" required></div><fieldset class="lobby-devices"><legend>Choose your devices</legend><label><input id="lobbyCamera" type="checkbox" checked> Camera on</label><label><input id="lobbyMic" type="checkbox" checked> Microphone on</label><p id="deviceStatus" aria-live="polite">Camera and microphone are selected. Your browser will ask for permission when you join.</p></fieldset><details class="meeting-terms"><summary>Read Terms &amp; Conditions</summary><div><p>By joining, you agree to participate respectfully and understand that your selected camera and microphone may be shared with everyone in this meeting.</p><p>Meeting links can be used by anyone who has them. Do not share links publicly. Get clear consent from participants before recording or sharing meeting content. Recordings made with this app stay in your browser for download.</p><p>Meeting details and notes are stored by this local app. Meetflow is a development demo, not an emergency service or a place for sensitive information.</p></div></details><label class="terms-accept"><input id="acceptTerms" type="checkbox"><span>I agree to the Terms &amp; Conditions.</span></label><button class="btn btn-primary" id="joinNow" disabled>Join meeting →</button>`);
 const acceptTerms=$("#acceptTerms"),joinButton=$("#joinNow"),deviceStatus=$("#deviceStatus");
 acceptTerms.addEventListener("change",()=>{joinButton.disabled=!acceptTerms.checked;});
 joinButton.onclick=async()=>{
  if(!acceptTerms.checked)return;
  const constraints={video:$("#lobbyCamera").checked,audio:$("#lobbyMic").checked};
  let preparedStream=null;
  if(constraints.video||constraints.audio){
   joinButton.disabled=true;
   joinButton.textContent="Checking devices…";
   deviceStatus.textContent="Allow the selected devices in your browser prompt.";
   try{preparedStream=await captureMedia(constraints);}
   catch(error){
    const availableStreams=[];
    const unavailableDevices=[];
    for(const device of ["video","audio"]){
     if(!constraints[device])continue;
     try{availableStreams.push(await captureMedia({video:device==="video",audio:device==="audio"}));}
     catch(deviceError){unavailableDevices.push(`${device==="video"?"Camera":"Microphone"}: ${deviceError.message}`);}
    }
    const availableTracks=availableStreams.flatMap(stream=>stream.getTracks());
    if(availableTracks.length){
     preparedStream=new MediaStream(availableTracks);
     if(unavailableDevices.length){
      deviceStatus.textContent=`${unavailableDevices.join(". ")}. Joining with the available device.`;
      toast("One selected device could not start. Joining with the available device.");
     }
    }else{
     deviceStatus.textContent=`Couldn't access the selected devices: ${error.message}. Joining with camera and microphone off; you can enable them from the meeting controls.`;
     toast("Couldn't access the selected devices. Joining without camera or microphone.");
    }
   }
  }
  if(backdrop.hidden){preparedStream?.getTracks().forEach(track=>track.stop());return;}
  state.displayName=$("#lobbyName").value.trim()||"Guest";
  closeModal();
  await startMeeting(preparedStream);
 };
}
function updateLocalMediaControls(){
 const hasAudio=!!state.localStream?.getAudioTracks().length;
 const hasVideo=!!state.localStream?.getVideoTracks().length;
 $("#toggleMic").classList.toggle("active",!hasAudio||state.muted);
 $("#toggleCam").classList.toggle("active",!hasVideo||state.cameraOff);
 const micLabel=hasAudio?(state.muted?"Unmute":"Mute"):"Enable mic";
 const cameraLabel=hasVideo?(state.cameraOff?"Start video":"Stop video"):"Start video";
 $("#toggleMic").querySelector("small").textContent=micLabel;
 $("#toggleCam").querySelector("small").textContent=cameraLabel;
 setControlIcon($("#toggleMic"),state.muted||!hasAudio?controlIcons.micOff:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>',micLabel);
 setControlIcon($("#toggleCam"),state.cameraOff||!hasVideo?controlIcons.cameraOff:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>',cameraLabel);
}
async function negotiatePeerMedia(peerId,pc){
 const negotiate=async()=>{
  if(state.ws?.readyState!==WebSocket.OPEN)return;
  if(pc.signalingState!=="stable"){
   pc.addEventListener("signalingstatechange",negotiate);
   return;
  }
  pc.removeEventListener("signalingstatechange",negotiate);
  try{
   const offer=await pc.createOffer();
   await pc.setLocalDescription(offer);
   sendSignal({type:"offer",target:peerId,description:pc.localDescription});
  }catch(error){console.error(error);toast("Could not add your camera or microphone to the meeting.");}
 };
 if(state.ws?.readyState!==WebSocket.OPEN)state.ws?.addEventListener("open",negotiate,{once:true});
 else await negotiate();
}
async function enableLocalMedia(constraints={video:true,audio:true}){
 try{
  const incoming=await captureMedia(constraints);
  const existingTracks=state.localStream?.getTracks()||[];
  state.localStream=new MediaStream([...existingTracks,...incoming.getTracks()]);
  state.mediaReady=true;
  state.muted=!state.localStream.getAudioTracks().length;
  state.cameraOff=!state.localStream.getVideoTracks().length;
  const tile=$(`[data-peer="${CSS.escape(state.participantId)}"]`);
  if(tile)setVideoStream(tile.querySelector("video"),state.localStream,tile.querySelector(".avatar-fallback"),true);
  updateLocalMediaControls();
  updateLocalState();
  for(const [peerId,pc] of state.peers){
   let addedTrack=false;
   for(const track of incoming.getTracks()){
    if(pc.getSenders().some(sender=>sender.track===track))continue;
    const sender=pc.addTrack(track,state.localStream);
    if(track.kind==="video")await preferVideoResolution(sender);
    addedTrack=true;
   }
   if(addedTrack)void negotiatePeerMedia(peerId,pc);
  }
  return true;
 }catch(error){
  toast(`Camera/microphone unavailable: ${error.message}. You can still join and retry from the meeting controls.`);
  updateLocalMediaControls();
  return false;
 }
}
async function startMeeting(preparedStream=null){
 meetingShell.hidden=false;document.body.style.overflow="hidden";
 $("#roomTitle").textContent=state.meeting.title;$("#roomCode").textContent=state.meeting.code;
 $("#videoGrid").innerHTML="";$("#chatMessages").innerHTML=`<div class="chat-empty">Say hello to get the conversation started.</div>`;state.peers.clear();state.peerNames.clear();state.chat=[];
 state.localStream=preparedStream;state.mediaReady=!!preparedStream;state.muted=!preparedStream?.getAudioTracks().some(track=>track.enabled);state.cameraOff=!preparedStream?.getVideoTracks().some(track=>track.enabled);
 addVideoTile(state.participantId,state.displayName,state.localStream,true);
 updateLocalMediaControls();
 const protocol=location.protocol==="https:"?"wss":"ws";
 state.ws=new WebSocket(`${protocol}://${location.host}/ws/${state.meeting.code}/${encodeURIComponent(state.participantId)}`);
 state.ws.onopen=()=>{$("#connectionStatus").classList.add("connected");$("#connectionStatus").innerHTML="<i></i> Connected";toast("Connected to meeting.");};
 state.ws.onmessage=async ev=>{let msg;try{msg=JSON.parse(ev.data)}catch{return;}await handleSignal(msg);};
 state.ws.onerror=()=>toast("Meeting signaling error. Check that the server is running.");
 state.ws.onclose=()=>{$("#connectionStatus").classList.remove("connected");$("#connectionStatus").innerHTML="<i></i> Disconnected";};
 hideMeetingLaunch();
 $("#stageCaption").textContent=`${state.displayName} · ${state.meeting.title}`;
 try{const n=await api(`/api/meetings/${state.meeting.code}/notes`);$("#meetingNotes").value=n.content||"";}catch{}
 renderPeople();
}
function sendSignal(msg){if(state.ws&&state.ws.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify(msg));}
async function handleSignal(msg){
 if(msg.type==="error"){toast(msg.message);return;}
 if(msg.type==="existing-peers"){for(const id of msg.peers||[])await makePeer(id,true);return;}
 if(msg.type==="peer-joined"){await makePeer(msg.peerId,false);return;}
 if(msg.type==="peer-left"){removePeer(msg.peerId);return;}
 if(msg.type==="offer"){
  let pc=state.peers.get(msg.from);if(!pc)pc=await makePeer(msg.from,false);
  try{await pc.setRemoteDescription(new RTCSessionDescription(msg.description));const answer=await pc.createAnswer();await pc.setLocalDescription(answer);sendSignal({type:"answer",target:msg.from,description:pc.localDescription});}catch(e){console.error(e);toast("Could not establish a peer connection.");}return;
 }
 if(msg.type==="answer"){const pc=state.peers.get(msg.from);if(pc)try{await pc.setRemoteDescription(new RTCSessionDescription(msg.description));}catch(e){console.error(e);}return;}
 if(msg.type==="ice"){const pc=state.peers.get(msg.from);if(pc&&msg.candidate)try{await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));}catch(e){console.warn("ICE candidate ignored",e);}return;}
 if(msg.type==="chat"){appendChat(msg.name||"Guest",msg.message,msg.time,false);return;}
 if(msg.type==="state"){const tile=$(`[data-peer="${CSS.escape(msg.from)}"]`);if(tile){tile.querySelector(".tile-state").textContent=`${msg.muted?"Mic off":"Mic on"} · ${msg.cameraOff?"Camera off":"Camera on"}`;tile.dataset.name=msg.name||"Guest";}renderPeople();return;}
 if(msg.type==="reaction"){toast(`${msg.name||"A participant"} reacted ${msg.emoji||"👏"}`);return;}
 if(msg.type==="raise-hand"){toast(`${msg.name||"A participant"} ${msg.raised?"raised a hand":"lowered their hand"}`);return;}
}
async function makePeer(peerId,initiator){
 if(!peerId||peerId===state.participantId)return state.peers.get(peerId);
 if(state.peers.has(peerId))return state.peers.get(peerId);
 const pc=new RTCPeerConnection(rtcConfig);state.peers.set(peerId,pc);state.peerNames.set(peerId,`Guest ${state.peers.size+1}`);
 if(state.localStream){
  for(const track of state.localStream.getTracks()){
   const sender=pc.addTrack(track,state.localStream);
   if(track.kind==="video")await preferVideoResolution(sender);
  }
 }
 pc.onicecandidate=e=>{if(e.candidate)sendSignal({type:"ice",target:peerId,candidate:e.candidate});};
 pc.ontrack=e=>{let tile=$(`[data-peer="${CSS.escape(peerId)}"]`);if(!tile)tile=addVideoTile(peerId,state.peerNames.get(peerId)||"Guest",null,false);const stream=e.streams[0];if(stream&&tile.querySelector("video").srcObject!==stream)setVideoStream(tile.querySelector("video"),stream,tile.querySelector(".avatar-fallback"));};
 pc.onconnectionstatechange=()=>{if(pc.connectionState==="failed")toast("A peer connection failed. A TURN server may be needed on this network.");};
 if(initiator){try{const offer=await pc.createOffer();await pc.setLocalDescription(offer);sendSignal({type:"offer",target:peerId,description:pc.localDescription});}catch(e){console.error(e);}}
 renderPeople();return pc;
}
function addVideoTile(id,name,stream,local){
 const old=$(`[data-peer="${CSS.escape(id)}"]`);if(old)old.remove();
 const tile=document.createElement("div");tile.className="video-tile";tile.dataset.peer=id;tile.dataset.name=name;
 const video=document.createElement("video");video.autoplay=true;video.playsInline=true;if(local)video.muted=true;
 const fallback=document.createElement("div");fallback.className="avatar-fallback";fallback.textContent=(name||"G").trim().charAt(0).toUpperCase();
 const label=document.createElement("span");label.className="tile-name";label.textContent=name+(local?" (You)":"");
 const stateLabel=document.createElement("span");stateLabel.className="tile-state";stateLabel.textContent=local?`${state.muted?"Mic off":"Mic on"} · ${state.cameraOff?"Camera off":"Camera on"}`:"Connecting…";
 tile.append(video,fallback,label,stateLabel);$("#videoGrid").append(tile);
 video.addEventListener("playing",()=>{fallback.style.display="none";});
 if(stream)setVideoStream(video,stream,fallback,local);
 return tile;
}
function setVideoStream(video,stream,fallback,notifyOnFailure=false){
 video.srcObject=stream;
 if(!stream?.getVideoTracks().length)return;
 video.play().then(()=>{fallback.style.display="none";}).catch(error=>{
  console.warn("Video preview could not start:",error);
  if(notifyOnFailure)toast("Camera is connected, but the preview could not play. Check browser playback permissions and retry the camera.");
 });
}
function removePeer(id){const pc=state.peers.get(id);if(pc){pc.close();state.peers.delete(id);}state.peerNames.delete(id);$(`[data-peer="${CSS.escape(id)}"]`)?.remove();renderPeople();}
function renderPeople(){
 const entries=[{id:state.participantId,name:state.displayName,local:true},...Array.from(state.peers.keys()).map(id=>({id,name:state.peerNames.get(id)||"Guest",local:false}))];
 $("#peopleList").innerHTML=entries.map(p=>`<div class="person-row"><span class="person-avatar">${escapeHtml(p.name.charAt(0).toUpperCase())}</span><div>${escapeHtml(p.name)}${p.local?" (You)":""}<small>${p.local?"Meeting participant":"Connected participant"}</small></div></div>`).join("");
}
$("#toggleMic").onclick=async()=>{if(!state.localStream?.getAudioTracks().length){await enableLocalMedia({audio:true});return;}state.muted=!state.muted;state.localStream.getAudioTracks().forEach(t=>t.enabled=!state.muted);updateLocalMediaControls();updateLocalState();};
$("#toggleCam").onclick=async()=>{if(!state.localStream?.getVideoTracks().length){await enableLocalMedia({video:true});return;}state.cameraOff=!state.cameraOff;state.localStream.getVideoTracks().forEach(t=>t.enabled=!state.cameraOff);updateLocalMediaControls();const tile=$(`[data-peer="${CSS.escape(state.participantId)}"]`);if(tile)tile.querySelector(".avatar-fallback").style.display=state.cameraOff?"grid":"none";updateLocalState();};
function updateLocalState(){const tile=$(`[data-peer="${CSS.escape(state.participantId)}"]`);if(tile)tile.querySelector(".tile-state").textContent=`${state.muted?"Mic off":"Mic on"} · ${state.cameraOff?"Camera off":"Camera on"}`;sendSignal({type:"state",name:state.displayName,muted:state.muted,cameraOff:state.cameraOff});}
$("#shareScreen").onclick=async()=>{
 if(!navigator.mediaDevices?.getDisplayMedia){toast("Screen sharing is not supported in this browser.");return;}
 if(state.screenSharing){stopScreenShare();return;}
 try{const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});state.screenStream=stream;state.screenSharing=true;
  const track=stream.getVideoTracks()[0];
  for(const pc of state.peers.values()){const sender=pc.getSenders().find(s=>s.track?.kind==="video");if(sender)await sender.replaceTrack(track);}
  const localTile=$(`[data-peer="${CSS.escape(state.participantId)}"]`);if(localTile){localTile.querySelector("video").srcObject=stream;localTile.querySelector(".avatar-fallback").style.display="none";localTile.querySelector(".tile-name").textContent=`${state.displayName} (Sharing screen)`;}
  $("#shareScreen").classList.add("active");$("#shareScreen").querySelector("small").textContent="Stop sharing";$("#shareScreen").title="Stop sharing";$("#shareScreen").setAttribute("aria-label","Stop sharing");track.addEventListener("ended",stopScreenShare);announce("Screen sharing has started.");
 }catch(e){toast(e.name==="NotAllowedError"?"Screen sharing permission was cancelled.":`Screen share failed: ${e.message}`);}
};
async function stopScreenShare(){
 if(!state.screenSharing)return;state.screenSharing=false;
 state.screenStream?.getTracks().forEach(t=>t.stop());state.screenStream=null;
 const cameraTrack=state.localStream?.getVideoTracks()[0]||null;
 for(const pc of state.peers.values()){const sender=pc.getSenders().find(s=>s.track?.kind==="video");if(sender)try{await sender.replaceTrack(cameraTrack);}catch{}}
 const tile=$(`[data-peer="${CSS.escape(state.participantId)}"]`);if(tile){tile.querySelector("video").srcObject=state.localStream||null;tile.querySelector(".tile-name").textContent=`${state.displayName} (You)`;tile.querySelector(".avatar-fallback").style.display=state.cameraOff||!cameraTrack?"grid":"none";}
 $("#shareScreen").classList.remove("active");$("#shareScreen").querySelector("small").textContent="Share screen";$("#shareScreen").title="Share screen";$("#shareScreen").setAttribute("aria-label","Share screen");announce("Screen sharing has stopped.");
}
$("#copyInvite").onclick=async()=>{try{await navigator.clipboard.writeText(`${location.origin}/?meeting=${state.meeting.code}`);toast("Invitation link copied.");}catch{toast(`Meeting code: ${state.meeting.code}`);}};
$("#chatForm").addEventListener("submit",e=>{e.preventDefault();const input=$("#chatInput"),message=input.value.trim();if(!message)return;const msg={type:"chat",name:state.displayName,message,time:new Date().toISOString()};appendChat(msg.name,msg.message,msg.time,true);sendSignal(msg);input.value="";});
function appendChat(name,message,time,own){const empty=$("#chatMessages .chat-empty");empty?.remove();const item=document.createElement("div");item.className="chat-message";const b=document.createElement("b");b.textContent=name;const t=document.createElement("span");t.className="message-time";t.textContent=new Date(time||Date.now()).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});b.append(t);const body=document.createElement("div");body.textContent=message;item.append(b,body);$("#chatMessages").append(item);$("#chatMessages").scrollTop=$("#chatMessages").scrollHeight;}
$$(".panel-tab").forEach(btn=>btn.onclick=()=>{ $$(".panel-tab").forEach(b=>b.classList.toggle("active",b===btn));["chat","people","notes"].forEach(name=>$("#"+name+"Panel").hidden=name!==btn.dataset.panel);});
$("#saveNotes").onclick=async()=>{try{await api(`/api/meetings/${state.meeting.code}/notes`,{method:"PUT",body:JSON.stringify({content:$("#meetingNotes").value})});toast("Meeting notes saved.");}catch(e){toast(e.message);}};
$("#raiseHand").onclick=()=>{state.raisedHand=!state.raisedHand;$("#raiseHand").classList.toggle("active",state.raisedHand);$("#raiseHand").querySelector("small").textContent=state.raisedHand?"Lower hand":"Raise hand";sendSignal({type:"raise-hand",name:state.displayName,raised:state.raisedHand});toast(state.raisedHand?"Hand raised.":"Hand lowered.");};
$("#focusMode").onclick=()=>{state.focus=!state.focus;meetingShell.classList.toggle("focus-active",state.focus);$("#focusMode").classList.toggle("active",state.focus);};
$("#toggleSide").onclick=()=>{const panel=$("#sidePanel");panel.hidden=!panel.hidden;$("#toggleSide").querySelector("small").textContent=panel.hidden?"Show panel":"Hide panel";};
$("#recordBtn").onclick=async()=>{
 if(state.recorder&&state.recorder.state==="recording"){state.recorder.stop();return;}
 let stream=state.screenSharing?state.screenStream:state.localStream;
 if(!stream){toast("Allow camera/microphone or start screen sharing before recording.");return;}
 const mimeTypes=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"];
 const mimeType=mimeTypes.find(t=>window.MediaRecorder&&MediaRecorder.isTypeSupported(t));
 if(!window.MediaRecorder||!mimeType){toast("Recording is not supported by this browser.");return;}
 try{
  const meetingCode=state.meeting.code;
  state.recordingChunks=[];state.recorder=new MediaRecorder(stream,{mimeType});
  state.recorder.ondataavailable=e=>{if(e.data&&e.data.size)state.recordingChunks.push(e.data);};
  state.recorder.onstop=()=>{const blob=new Blob(state.recordingChunks,{type:mimeType});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`meetflow-${meetingCode}-${Date.now()}.webm`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);meetingShell.classList.remove("recording");$("#recordBtn").querySelector("small").textContent="Record";setControlIcon($("#recordBtn"),controlIcons.recording,"Start recording");announce("Recording has stopped.");toast(`Recording downloaded (${(blob.size/1024/1024).toFixed(1)} MB). This is a local stream recording, not a composite of all participants.`);};
  state.recorder.start(1000);meetingShell.classList.add("recording");$("#recordBtn").querySelector("small").textContent="Stop recording";setControlIcon($("#recordBtn"),controlIcons.recordStop,"Stop recording");announce("Recording has started.");toast("This meeting is being recorded.");
 }catch(e){toast(`Could not start recording: ${e.message}`);}
};
$("#leaveMeeting").onclick=leaveMeeting;
async function leaveMeeting(){
 if(state.recorder&&state.recorder.state!=="inactive")state.recorder.stop();
 if(state.screenSharing)await stopScreenShare();
 sendSignal({type:"leave",name:state.displayName});
 if(state.ws){state.ws.close();state.ws=null;}
 for(const pc of state.peers.values())pc.close();state.peers.clear();
 state.localStream?.getTracks().forEach(t=>t.stop());state.localStream=null;
 state.screenStream?.getTracks().forEach(t=>t.stop());state.screenStream=null;
 state.joined=false;meetingShell.hidden=true;meetingShell.classList.remove("focus-active","recording");document.body.style.overflow="";
 state.meeting=null;history.replaceState(null,"",location.pathname);toast("You left the meeting.");
 await loadMeetings();
}
window.addEventListener("beforeunload",()=>{state.localStream?.getTracks().forEach(t=>t.stop());state.screenStream?.getTracks().forEach(t=>t.stop());if(state.ws)state.ws.close();});
const urlMeeting=new URLSearchParams(location.search).get("meeting");
if(urlMeeting)joinForm(urlMeeting);
