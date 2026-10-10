(() => {
  const dialog = document.getElementById('intake-dialog');
  const form = document.getElementById('intake-form');
  const manageForm = document.getElementById('manage-form');
  let manageMode=false;
  const review = document.getElementById('intake-review');
  const title = document.getElementById('intake-title');
  const description = document.getElementById('intake-description');
  const step = document.getElementById('intake-step');
  const status = document.getElementById('intake-status');
  const body = dialog.querySelector('.intake-body');
  const fileInput = document.getElementById('intake-file');
  const dropzone = document.getElementById('intake-dropzone');
  const filePreview = document.getElementById('intake-file-preview');
  const details = document.getElementById('intake-details');
  const phone = document.getElementById('intake-phone');
  const zip = document.getElementById('intake-zip');
  const state = document.getElementById('intake-state');
  const useState = document.getElementById('intake-use-state');
  const consent = document.getElementById('intake-consent');
  const sendButton = document.getElementById('intake-send');
  const editButton = document.getElementById('intake-edit');
  const connectPanel = document.getElementById('intake-connect');
  const checkButton = document.getElementById('intake-check-status');
  const newCodeButton = document.getElementById('intake-new-code');
  const maxFileSize = 10 * 1024 * 1024;
  const allowedExtensions = /\.(pdf|jpe?g|png|webp|heic|heif)$/i;
  const allowedTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
  let selectedFile = null;
  let previewUrl = null;
  let opener = null;
  let backdropPointerDown = false;
  let currentIntake = null;
  let connection = null;
  let verifiedConnection = null;
  let emailTimer = null;
  let pendingRequest = null;
  let pollTimer = null;
  let taskVersion = 0;
  let sending = false;

  function stopRequests() {
    clearTimeout(pollTimer);
    clearTimeout(emailTimer);
    pendingRequest?.abort();
    pendingRequest = null;
    taskVersion += 1;
  }

  function setSending(value) {
    sending = value;
    sendButton.disabled = value || !consent.checked;
    consent.disabled = value;
    editButton.disabled = value;
    review.setAttribute('aria-busy', String(value));
    sendButton.querySelector('.intake-send-label').textContent = value ? 'Sending…' : 'Send & connect';
  }

  function showConnection() {
    form.hidden = true;
    manageForm.hidden=true;
    review.hidden = true;
    connectPanel.hidden = false;
    title.textContent = 'One last step in Messages.';
    description.textContent = 'Confirm your number by replying to the message we sent.';
    step.textContent = '3 of 3 · Connect';
    document.getElementById('intake-connect-heading').textContent = manageMode ? 'Verify your existing connection.' : 'Your details have been received.';
    document.getElementById('intake-connect-description').textContent = manageMode ? 'We sent a verification message to your connected number. Reply with the MANAGE code to open your settings. Your saved conversation stays available.' : `We sent a connection message to ${document.getElementById('intake-review-phone').textContent}. Your bill details are saved while you connect; they have not been analyzed yet.`;
    document.getElementById('intake-code').textContent = connection.messageText;
    document.getElementById('intake-code-panel').hidden = false;
    document.getElementById('intake-copy-code').textContent = 'Copy';
    document.getElementById('intake-expiry').textContent = `Reply by ${new Date(connection.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Closing this window stops the connection check.`;
    document.getElementById('intake-connection-state').textContent = 'Waiting for your reply in Messages…';
    setError('poll', '');
    checkButton.hidden = true;
    newCodeButton.hidden = true;
    body.scrollTop = 0;
    title.focus({ preventScroll: true });
  }

  async function checkConnection() {
    if (!connection || !dialog.open || connectPanel.hidden) return;
    clearTimeout(pollTimer);
    const version = taskVersion;
    const activeConnection = connection;
    pendingRequest = new AbortController();
    checkButton.disabled = true;
    setError('poll', '');
    try {
      const result = await window.MoreTimeIntakeApi.status(activeConnection, pendingRequest.signal);
      if (version !== taskVersion) return;
      checkButton.hidden = true;
      if (result.status === 'connected') {
        document.getElementById('intake-code-panel').hidden = true;
        document.getElementById('intake-code').textContent = '';
        title.textContent = manageMode ? 'Manage your connection.' : 'You’re connected.';
        description.textContent = 'Your number and bill details are linked to this conversation.';
        document.getElementById('intake-connect-heading').textContent = manageMode ? 'Your settings are ready.' : 'Continue in your conversation.';
        document.getElementById('intake-connect-description').textContent = manageMode ? 'Connect Gmail or adjust your check-ins below. This settings session lasts 20 minutes. You can return through Manage connection whenever you need to.' : 'Check Messages for MoreTime’s reply. When the AI assistant is enabled, it will read your bill and ask you to confirm the important details. You can keep asking questions there. Closing this window does not end your conversation; reply STOP in Messages to disconnect and remove your saved case.';
        document.getElementById('intake-connection-state').textContent = 'Connection confirmed.';
        verifiedConnection=activeConnection;
        document.getElementById('intake-engagement').hidden=false;
        const first=new Date(Date.now()+3*86400000);
        first.setMinutes(first.getMinutes()-first.getTimezoneOffset());
        document.getElementById('followup-at').value=first.toISOString().slice(0,16);
        void refreshEmail();
        void refreshFollowUps();
        connection = null;
      } else if (result.status === 'expired' || Date.now() >= Date.parse(activeConnection.expiresAt)) {
        document.getElementById('intake-code-panel').hidden = true;
        document.getElementById('intake-code').textContent = '';
        document.getElementById('intake-connect-heading').textContent = 'This connection code has expired.';
        document.getElementById('intake-connect-description').textContent = 'Send a new code to try again with the details you entered. Your number has not been confirmed.';
        document.getElementById('intake-connection-state').textContent = 'Connection not completed.';
        newCodeButton.hidden = manageMode;
        if(manageMode){manageForm.hidden=false;document.getElementById('manage-error').hidden=true;}
      } else {
        pollTimer = setTimeout(checkConnection, 2000);
      }
    } catch (error) {
      if (version !== taskVersion || error.name === 'AbortError') return;
      setError('poll', 'We could not check the connection. If you replied in Messages, use Check again.');
      document.getElementById('intake-connection-state').textContent = 'Connection check paused.';
      checkButton.hidden = false;
    } finally {
      if (version === taskVersion) {
        pendingRequest = null;
        checkButton.disabled = false;
      }
    }
  }

  async function sendIntake() {
    if (sending || !currentIntake || !consent.checked) return;
    stopRequests();
    const version = taskVersion;
    pendingRequest = new AbortController();
    showStep(true, false);
    setError('submit', '');
    setSending(true);
    status.textContent = 'Sending your details and requesting a connection message…';
    try {
      const result = await window.MoreTimeIntakeApi.submit(currentIntake, pendingRequest.signal);
      if (version !== taskVersion) return;
      connection = result;
      pendingRequest = null;
      setSending(false);
      status.textContent = '';
      showConnection();
      void checkConnection();
    } catch (error) {
      if (version !== taskVersion || error.name === 'AbortError') return;
      setError('submit', error.message || 'We could not confirm the request. Check Messages before trying again.');
      status.textContent = '';
      setSending(false);
      pendingRequest = null;
      sendButton.focus({ preventScroll: true });
    }
  }

  function setError(name, message, fields = []) {
    const element = document.getElementById(`intake-${name}-error`);
    element.textContent = message;
    element.hidden = !message;
    fields.forEach(field => {
      if (message) field.setAttribute('aria-invalid', 'true');
      else field.removeAttribute('aria-invalid');
    });
  }

  function clearContextError() {
    if (selectedFile || details.value.trim()) {
      setError('context', '', [details]);
      if (document.getElementById('intake-file-error').hidden) fileInput.removeAttribute('aria-invalid');
    }
  }

  function updateFileDisplay(file = selectedFile) {
    dropzone.classList.toggle('has-file', Boolean(file));
    document.getElementById('intake-upload-intro').hidden = Boolean(file);
    document.getElementById('intake-drop-hint').hidden = Boolean(file);
    document.getElementById('intake-remove-file').hidden = !file;
    document.getElementById('intake-selected-file').hidden = !file;
    document.getElementById('intake-file-prompt').textContent = file ? 'Replace' : 'Choose file';
    fileInput.setAttribute('aria-label', file ? 'Replace attached bill or notice' : 'Choose a bill or notice');
    document.getElementById('intake-file-type').textContent = file ? file.name.split('.').pop().slice(0, 5).toUpperCase() : 'BILL';
    document.getElementById('intake-file-name').textContent = file?.name || '';
    document.getElementById('intake-file-size').textContent = file
      ? `${file.size < 1024 * 1024 ? `${Math.max(1, Math.ceil(file.size / 1024))} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`} · ${selectedFile ? 'Selected on this device' : 'Not attached'}`
      : '';
    filePreview.hidden = true;
    filePreview.removeAttribute('src');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    // Show a local thumbnail where supported; keep PDF/HEIC as a document tile.
    if (selectedFile && /\.(jpe?g|png|webp)$/i.test(selectedFile.name)) {
      previewUrl = URL.createObjectURL(selectedFile);
      filePreview.src = previewUrl;
    }
  }

  filePreview.addEventListener('load', () => {
    if (previewUrl && filePreview.currentSrc === previewUrl) filePreview.hidden = false;
  });
  filePreview.addEventListener('error', () => {
    filePreview.hidden = true;
  });

  function selectFiles(files) {
    if (!files.length) return;
    const candidate = files[0];
    let error = '';
    if (files.length > 1) error = 'Choose one bill or notice at a time.';
    else if (!allowedExtensions.test(candidate.name) || (candidate.type && !allowedTypes.has(candidate.type))) {
      error = 'Choose a PDF, JPG, PNG, WebP, HEIC or HEIF file.';
    } else if (candidate.size === 0) error = 'This file is empty. Choose another copy of your bill.';
    else if (candidate.size > maxFileSize) error = 'This file is too large. Choose one that’s 10 MB or smaller.';

    if (error) {
      // A rejected replacement must not silently submit the previous file.
      selectedFile = null;
      fileInput.value = '';
      setError('file', error, [fileInput]);
      status.textContent = error;
    } else {
      selectedFile = candidate;
      setError('file', '', [fileInput]);
      clearContextError();
      status.textContent = `${candidate.name} selected. Nothing has been uploaded.`;
    }
    updateFileDisplay(candidate);
  }

  function updateLocation() {
    const fallback = useState.checked;
    document.getElementById('intake-zip-field').hidden = fallback;
    document.getElementById('intake-state-field').hidden = !fallback;
    zip.disabled = fallback;
    zip.required = !fallback;
    state.disabled = !fallback;
    state.required = fallback;
    setError('location', '', [zip, state]);
  }

  function showStep(isReview, focusTitle = true) {
    manageForm.hidden=true;
    form.hidden = isReview;
    review.hidden = !isReview;
    connectPanel.hidden = true;
    title.textContent = isReview ? 'A quick check before we talk.' : 'Let’s start with your bill.';
    description.textContent = isReview
      ? 'Here’s what you’ve added. You can go back and change anything.'
      : 'Add a bill or tell us what’s happening. A few details are enough to start.';
    step.textContent = isReview ? '2 of 3 · Review' : '1 of 3 · Your details';
    body.scrollTop = 0;
    if (focusTitle) title.focus({ preventScroll: true });
  }

  function clearForm() {
    stopRequests();
    manageMode=false;
    manageForm.reset();
    manageForm.hidden=true;
    verifiedConnection = null;
    document.getElementById('intake-engagement').hidden=true;
    document.getElementById('followup-consent').checked=false;
    document.getElementById('email-consent').checked=false;
    document.getElementById('followup-status').textContent='';
    document.getElementById('email-status').textContent='';
    currentIntake = null;
    connection = null;
    consent.checked = false;
    setSending(false);
    form.reset();
    selectedFile = null;
    updateFileDisplay();
    updateLocation();
    setError('file', '', [fileInput]);
    setError('context', '', [details]);
    setError('phone', '', [phone]);
    setError('submit', '');
    setError('poll', '');
    document.getElementById('intake-code').textContent = '';
    document.getElementById('intake-connect-description').textContent = '';
    review.querySelectorAll('dd').forEach(value => { value.textContent = ''; });
    status.textContent = '';
    dropzone.classList.remove('is-dragging');
    showStep(false, false);
  }

  document.querySelectorAll('[data-manage-connection]').forEach(button=>button.addEventListener('click',()=>{
    opener=button;manageMode=true;form.hidden=true;review.hidden=true;connectPanel.hidden=true;manageForm.hidden=false;
    document.getElementById('manage-error').hidden=true;
    title.textContent='Manage your connection.';description.textContent='Verify your existing number to connect Gmail or adjust check-ins.';step.textContent='Settings · Verify';
    dialog.showModal();document.body.classList.add('intake-open');title.focus({preventScroll:true});
  }));
  manageForm.addEventListener('submit',async event=>{
    event.preventDefault();
    const raw=document.getElementById('manage-phone').value.trim(),digits=raw.replace(/\D/g,''),national=digits.length===11&&digits.startsWith('1')?digits.slice(1):digits;
    const output=document.getElementById('manage-error');
    if(!/^\+?[\d\s().-]+$/.test(raw)||!/[2-9]\d{2}[2-9]\d{6}$/.test(national)||national.length!==10||!document.getElementById('manage-consent').checked){output.textContent='Enter your connected U.S. phone number and approve the verification message.';output.hidden=false;return;}
    stopRequests();const version=taskVersion,button=document.getElementById('manage-submit');pendingRequest=new AbortController();button.disabled=true;output.hidden=true;
    try{const result=await window.MoreTimeIntakeApi.manage(`+1${national}`,pendingRequest.signal);if(version!==taskVersion)return;connection=result;showConnection();void checkConnection();}
    catch(error){if(version===taskVersion&&error.name!=='AbortError'){output.textContent=error.message||'Could not send verification. Try again.';output.hidden=false;}}
    finally{button.disabled=false;}
  });
  document.querySelectorAll('[data-open-intake]').forEach(button => {
    button.addEventListener('click', () => {
      opener = button;
      dialog.showModal();
      document.body.classList.add('intake-open');
      title.focus({ preventScroll: true });
    });
  });

  dialog.querySelectorAll('[data-close-intake]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')]
      .filter(control => control.getClientRects().length);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === title)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener('close', () => {
    clearForm();
    document.body.classList.remove('intake-open');
    opener?.focus({ preventScroll: true });
    backdropPointerDown = false;
  });

  const outsideDialog = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  dialog.addEventListener('pointerdown', event => { backdropPointerDown = event.target === dialog && outsideDialog(event); });
  dialog.addEventListener('click', event => {
    if (backdropPointerDown && event.target === dialog && outsideDialog(event)) dialog.close();
    backdropPointerDown = false;
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) selectFiles(fileInput.files);
    else {
      selectedFile = null;
      setError('file', '', [fileInput]);
      updateFileDisplay();
    }
  });
  document.getElementById('intake-remove-file').addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    setError('file', '', [fileInput]);
    updateFileDisplay();
    status.textContent = 'Attachment removed.';
    fileInput.focus();
  });

  // Keep drag-and-drop inside the preview; never navigate to an incoming file.
  dialog.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    if (!form.hidden) dropzone.classList.add('is-dragging');
  });
  dialog.addEventListener('dragleave', event => {
    if (!dialog.contains(event.relatedTarget)) dropzone.classList.remove('is-dragging');
  });
  dialog.addEventListener('drop', event => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
    if (!form.hidden && event.dataTransfer.files.length) {
      fileInput.value = '';
      selectFiles(event.dataTransfer.files);
    }
  });

  details.addEventListener('input', clearContextError);
  phone.addEventListener('input', () => setError('phone', '', [phone]));
  zip.addEventListener('input', () => setError('location', '', [zip]));
  state.addEventListener('change', () => setError('location', '', [state]));
  useState.addEventListener('change', () => {
    updateLocation();
    (useState.checked ? state : zip).focus();
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    const rawPhone = phone.value.trim();
    const digits = rawPhone.replace(/\D/g, '');
    const nationalNumber = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    const validPhone = /^\+?[\d\s().-]+$/.test(rawPhone) && /^[2-9]\d{2}[2-9]\d{6}$/.test(nationalNumber) && (!rawPhone.startsWith('+') || (digits.length === 11 && digits.startsWith('1')));
    const contextError = selectedFile || details.value.trim() ? '' : 'Add a bill or tell us what’s happening to continue.';
    const phoneError = validPhone ? '' : 'Enter a 10-digit U.S. phone number, with an optional +1.';
    const locationError = useState.checked
      ? (state.value ? '' : 'Choose your state or territory.')
      : (/^\d{5}(-\d{4})?$/.test(zip.value.trim()) ? '' : 'Enter a 5-digit ZIP code, or use your state instead.');
    const fileError = !document.getElementById('intake-file-error').hidden;
    setError('context', contextError, [details]);
    setError('phone', phoneError, [phone]);
    setError('location', locationError, [useState.checked ? state : zip]);
    if (contextError) fileInput.setAttribute('aria-invalid', 'true');
    else if (!fileError) fileInput.removeAttribute('aria-invalid');

    if (fileError || contextError || phoneError || locationError) {
      status.textContent = 'Please check the highlighted fields before reviewing your details.';
      (fileError ? fileInput : contextError ? details : phoneError ? phone : useState.checked ? state : zip).focus();
      return;
    }

    const intake = {
      bill: selectedFile,
      details: details.value.trim(),
      phone: `+1${nationalNumber}`,
      location: useState.checked ? { state: state.value } : { zipCode: zip.value.trim() }
    };
    currentIntake = intake;
    consent.checked = false;
    setSending(false);
    setError('submit', '');
    document.getElementById('intake-review-file-row').hidden = !intake.bill;
    document.getElementById('intake-review-file').textContent = intake.bill?.name || '';
    document.getElementById('intake-review-details-row').hidden = !intake.details;
    document.getElementById('intake-review-details').textContent = intake.details;
    document.getElementById('intake-review-phone').textContent = `+1 (${nationalNumber.slice(0, 3)}) ${nationalNumber.slice(3, 6)}-${nationalNumber.slice(6)}`;
    document.getElementById('intake-review-location-label').textContent = useState.checked ? 'State or territory' : 'ZIP code';
    document.getElementById('intake-review-location').textContent = useState.checked ? state.selectedOptions[0].textContent : intake.location.zipCode;
    status.textContent = '';
    showStep(true);
  });

  editButton.addEventListener('click', () => {
    if (sending) return;
    consent.checked = false;
    setSending(false);
    showStep(false);
  });
  consent.addEventListener('change', () => { sendButton.disabled = sending || !consent.checked; });
  sendButton.addEventListener('click', sendIntake);
  checkButton.addEventListener('click', checkConnection);
  newCodeButton.addEventListener('click', sendIntake);
  document.getElementById('intake-copy-code').addEventListener('click', async () => {
    const code = document.getElementById('intake-code');
    if (!code.textContent) return;
    const button = document.getElementById('intake-copy-code');
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = 'Select & copy';
    }
  });
  async function refreshFollowUps() {
    const active=verifiedConnection;if(!active)return;
    try{
      const saved=await window.MoreTimeIntakeApi.engagement(active,'/api/follow-ups');
      if(active!==verifiedConnection)return;
      document.getElementById('followup-status').textContent=saved.enabled?`Check-ins enabled. Next check-in: ${new Date(saved.nextAt).toLocaleString()}.`:'Check-ins are paused. Choose a time and approve them to enable.';
      if(saved.nextAt){const local=new Date(saved.nextAt);local.setMinutes(local.getMinutes()-local.getTimezoneOffset());document.getElementById('followup-at').value=local.toISOString().slice(0,16);}
    }catch{if(active===verifiedConnection)document.getElementById('followup-status').textContent='Could not load check-in settings. Your saved schedule has not been changed.';}
  }
  async function refreshEmail() {
    if(!verifiedConnection||!dialog.open)return;
    const active=verifiedConnection;
    try {
      const email=await window.MoreTimeIntakeApi.engagement(active,'/api/email');
      if(active!==verifiedConnection)return;
      document.getElementById('email-connect').disabled=!email.available;
      document.getElementById('email-disconnect').hidden=!email.connected;
      document.getElementById('email-status').textContent=email.connected?`Connected: ${email.email}. Alerts run while check-ins are enabled.`:email.available?'Gmail is not connected.':'Gmail connection is awaiting setup by the MoreTime team.';
      return email.connected;
    } catch {if(active===verifiedConnection)document.getElementById('email-status').textContent='Could not check Gmail connection. Try again.';}
  }
  document.getElementById('followup-save').addEventListener('click',async()=>{
    if(!verifiedConnection)return;
    const active=verifiedConnection,button=document.getElementById('followup-save'),output=document.getElementById('followup-status');
    const at=new Date(document.getElementById('followup-at').value).getTime();
    if(!document.getElementById('followup-consent').checked){output.textContent='Please approve the check-in schedule first.';return;}
    if(!Number.isFinite(at)||at<Date.now()+60000||at>Date.now()+30*86400000){output.textContent='Choose a time at least a minute from now and within 30 days.';return;}
    button.disabled=true;
    try {
      const saved=await window.MoreTimeIntakeApi.engagement(active,'/api/follow-ups','POST',{consent:true,nextAt:new Date(at).toISOString()});
      if(active===verifiedConnection)output.textContent=`Check-ins enabled. First check-in: ${new Date(saved.nextAt).toLocaleString()}. Then weekly for up to 90 days.`;
    }catch{if(active===verifiedConnection)output.textContent='Could not confirm the schedule. Try again.';}
    finally{button.disabled=false;}
  });
  document.getElementById('followup-pause').addEventListener('click',async()=>{
    if(!verifiedConnection)return;
    const active=verifiedConnection;
    try{await window.MoreTimeIntakeApi.engagement(active,'/api/follow-ups','DELETE');if(active===verifiedConnection)document.getElementById('followup-status').textContent='Check-ins and email notice alerts are paused.';}
    catch{if(active===verifiedConnection)document.getElementById('followup-status').textContent='Could not confirm the pause. Reply FOLLOWUPS OFF in Messages.';}
  });
  document.getElementById('email-connect').addEventListener('click',async()=>{
    if(!verifiedConnection)return;
    const active=verifiedConnection,output=document.getElementById('email-status');
    if(!document.getElementById('email-consent').checked){output.textContent='Please agree to email monitoring before connecting Gmail.';return;}
    const popup=window.open('about:blank','moretime-email','popup,width=540,height=720');
    if(!popup){output.textContent='Allow pop-ups for MoreTime, then try again.';return;}
    const version=taskVersion;
    try {
      const result=await window.MoreTimeIntakeApi.engagement(active,'/api/email/connect','POST',{consent:true});
      if(active!==verifiedConnection){popup.close();return;}
      const auth=new URL(result.authorizationUrl);
      if(auth.origin!=='https://accounts.google.com'||auth.pathname!=='/o/oauth2/v2/auth')throw new Error('invalid_redirect');
      popup.location.href=auth.href;
      output.textContent='Finish connecting in the Google window.';
      let attempts=0;
      const poll=async()=>{
        if(version!==taskVersion||active!==verifiedConnection)return;
        if(await refreshEmail())return;
        if(version!==taskVersion||active!==verifiedConnection)return;
        if(++attempts<100&&!popup.closed)emailTimer=setTimeout(poll,3000);
      };
      emailTimer=setTimeout(poll,3000);
    }catch{popup.close();if(active===verifiedConnection)output.textContent='Gmail connection could not start. Try again after MoreTime email setup is complete.';}
  });
  document.getElementById('email-disconnect').addEventListener('click',async()=>{
    if(!verifiedConnection)return;
    const active=verifiedConnection;
    try{await window.MoreTimeIntakeApi.engagement(active,'/api/email','DELETE');if(active===verifiedConnection)await refreshEmail();}
    catch{if(active===verifiedConnection)document.getElementById('email-status').textContent='Could not confirm disconnection. Reply EMAIL OFF in Messages.';}
  });
  window.addEventListener('pagehide', () => {
    dialog.close();
    clearForm();
    document.body.classList.remove('intake-open');
  });
})();
