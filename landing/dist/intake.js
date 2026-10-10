(() => {
  const dialog = document.getElementById('intake-dialog');
  const form = document.getElementById('intake-form');
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
  let pendingRequest = null;
  let pollTimer = null;
  let taskVersion = 0;
  let sending = false;

  function stopRequests() {
    clearTimeout(pollTimer);
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
    review.hidden = true;
    connectPanel.hidden = false;
    title.textContent = 'One last step in Messages.';
    description.textContent = 'Confirm your number by replying to the message we sent.';
    step.textContent = '3 of 3 · Connect';
    document.getElementById('intake-connect-heading').textContent = 'Your details have been received.';
    document.getElementById('intake-connect-description').textContent = `We sent a connection message to ${document.getElementById('intake-review-phone').textContent}. Your bill details are saved while you connect; they have not been analyzed yet.`;
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
        title.textContent = 'You’re connected.';
        description.textContent = 'Your number and bill details are linked to this conversation.';
        document.getElementById('intake-connect-heading').textContent = 'Your details are saved.';
        document.getElementById('intake-connect-description').textContent = 'You can return to your MoreTime conversation in Messages. Your details remain saved when you close this window. The AI assistant is still in development, so your bill has not been analyzed yet.';
        document.getElementById('intake-connection-state').textContent = 'Connection confirmed.';
        connection = null;
      } else if (result.status === 'expired' || Date.now() >= Date.parse(activeConnection.expiresAt)) {
        document.getElementById('intake-code-panel').hidden = true;
        document.getElementById('intake-code').textContent = '';
        document.getElementById('intake-connect-heading').textContent = 'This connection code has expired.';
        document.getElementById('intake-connect-description').textContent = 'Send a new code to try again with the details you entered. Your number has not been confirmed.';
        document.getElementById('intake-connection-state').textContent = 'Connection not completed.';
        newCodeButton.hidden = false;
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
  window.addEventListener('pagehide', () => {
    dialog.close();
    clearForm();
    document.body.classList.remove('intake-open');
  });
})();
