(() => {
  const localHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const defaultBase = localHost ? `http://${window.location.hostname}:8080` : window.location.origin;

  class IntakeError extends Error {
    constructor(message, { uncertain = false, status = 0 } = {}) {
      super(message);
      this.name = 'IntakeError';
      this.uncertain = uncertain;
      this.status = status;
    }
  }

  function endpoint(path) {
    let base;
    try { base = new URL(window.MORETIME_API_BASE_URL || defaultBase); }
    catch { throw new IntakeError('Open this page from the MoreTime website to connect.'); }
    const local = ['localhost', '127.0.0.1'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(local && base.protocol === 'http:')) || base.username || base.password) {
      throw new IntakeError('The connection service needs a secure website address.');
    }
    return new URL(path, base.origin).href;
  }

  async function request(path, options, signal) {
    const url = endpoint(path);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 30_000);
    try {
      const response = await fetch(url, {
        ...options, signal: controller.signal, cache: 'no-store', credentials: options.credentials || 'omit', redirect: 'error',
      });
      if (!response.ok) {
        const messages = {
          400: 'Check your bill details, phone number, and location, then try again.',
          401: 'This connection request is no longer available. Start a new request.',
          403: 'This page is not enabled for connections yet. Please try again later.',
          404: path === '/api/connection/manage' ? 'This number is not connected. Use Start with a conversation first.' : 'The connection service is not ready yet. Your details have not been accepted.',
          409: 'This number is already connected. Continue in your existing MoreTime conversation.',
          413: 'Choose a bill that is 10 MB or smaller.',
          415: 'Choose a PDF or a supported image of your bill.',
          429: 'Too many connection requests. Please wait five minutes before trying again.',
          502: 'We could not send the connection message. Check that this number is enabled for the hackathon demo.',
          503: 'The connection service is temporarily unavailable. Please try again later.',
        };
        const uncertain = response.status >= 500 && ![502, 503].includes(response.status);
        throw new IntakeError(messages[response.status] || 'We could not confirm the request. Check Messages before trying again.', { status: response.status, uncertain });
      }
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      if (error instanceof IntakeError) throw error;
      throw new IntakeError('We could not confirm the request. Check Messages before trying again.', { uncertain: true });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  window.MoreTimeIntakeApi = Object.freeze({
    async submit(intake, signal) {
      const payload = new FormData();
      payload.set('address', intake.phone);
      payload.set('details', intake.details);
      payload.set(intake.location.state ? 'state' : 'zipCode', intake.location.state || intake.location.zipCode);
      payload.set('consent', 'true');
      if (intake.bill) payload.set('bill', intake.bill, intake.bill.name);
      const result = await request('/api/intake', { method: 'POST', body: payload }, signal);
      if (!result || typeof result !== 'object' || typeof result.intakeId !== 'string' || !result.intakeId ||
          typeof result.accessToken !== 'string' || !result.accessToken ||
          result.status !== 'pending' || !/^CONNECT [A-F0-9]{24}$/.test(result.messageText) ||
          !Number.isFinite(Date.parse(result.expiresAt))) {
        throw new IntakeError('We could not confirm the connection request. Check Messages before trying again.', { uncertain: true });
      }
      return result;
    },
    async manage(phone, signal) {
      const result=await request('/api/connection/manage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:phone,consent:true})},signal);
      if(!result||typeof result.accessToken!=='string'||!/^MANAGE [A-F0-9]{24}$/.test(result.messageText)||!Number.isFinite(Date.parse(result.expiresAt)))throw new IntakeError('Could not confirm the management request. Check Messages.');
      return {...result,management:true};
    },
    async engagement(connection, path, method = 'GET', body, signal) {
      return request(path, { method, credentials: path === '/api/email/connect' ? 'include' : 'omit', headers: { Authorization: `Bearer ${connection.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, signal);
    },
    async status(connection, signal) {
      const result = await request(connection.management ? '/api/connection/manage/status' : '/api/intake/status', {
        method: 'GET', headers: { Authorization: `Bearer ${connection.accessToken}` },
      }, signal);
      if (!result || result.intakeId !== connection.intakeId || !['pending', 'connected', 'expired'].includes(result.status)) {
        throw new IntakeError('We could not check the connection. You can check again here.');
      }
      return result;
    },
  });
})();
