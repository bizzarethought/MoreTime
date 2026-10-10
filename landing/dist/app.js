const examples = {
  "shutoff": {
    "steps": [
      {
        "user": "They’re cutting off my power. I can’t afford the full bill.",
        "assistant": "I can help you check for shutoff protections and prepare a request for more time. What state are you in, who is your utility, and what shutoff date is on the notice? Has anything changed with your income or health?",
        "next": "Start with your location, utility, notice date, and circumstances.",
        "action": "Add the example details"
      },
      {
        "user": "I’m in New Jersey with Example Electric. The notice says December 7, 2026. I recently lost my job.",
        "assistant": "New Jersey’s Winter Termination Program may cover unemployment-related hardship from November 15 to March 15. You need to notify your utility and confirm eligibility. I can help you prepare the call—would you like a short script?",
        "next": "Check Winter Termination Program eligibility with the utility.",
        "action": "Help me prepare the call"
      },
      {
        "user": "Yes, I’m nervous about calling. What should I say?",
        "assistant": "I can help you go into the call with a clear request. Have your account number and notice ready, then use this as a starting point.",
        "draft": {
          "title": "Your call script",
          "text": "Hi, I’m calling about the shutoff notice dated for December 7. I recently lost my job and can’t pay the full balance. I’d like to request Winter Termination Program protection.\n\nCan you review my eligibility, explain any steps I need to take, and confirm the outcome in writing?"
        },
        "next": "Write down the confirmation and next steps. Protection does not erase the balance."
      }
    ],
    "source": {
      "url": "https://www.nj.gov/bpu/assistance/programs/",
      "label": "NJBPU · Winter Termination Program",
      "context": "New Jersey example · Confirm eligibility and provider coverage."
    }
  },
  "payment": {
    "steps": [
      {
        "user": "My gas company says I have to pay the whole overdue balance. Can you help?",
        "assistant": "Yes—we can prepare a payment-plan request. What state are you in, how much is overdue, and what could you pay each month on top of new bills? Have you already had a payment plan this year?",
        "next": "Gather the balance, location, budget, and any previous plan details.",
        "action": "Add the example budget"
      },
      {
        "user": "New Jersey. I owe $600 and can pay $50 a month toward it, plus my new bills. I haven’t had a plan this year.",
        "assistant": "New Jersey’s utility protections include at least one deferred payment plan per year that considers your finances, while new charges stay current. I can draft a request using your $50 budget. Shall we put it into words?",
        "next": "Propose terms you can manage; the utility still needs to confirm the arrangement.",
        "action": "Draft my payment request"
      },
      {
        "user": "Please. I’d rather send a message than call.",
        "assistant": "Here’s a draft you can review and send through your utility’s contact channel. Add your account details there when you’re ready.",
        "draft": {
          "title": "Your payment-plan request",
          "text": "Hello, I’m requesting a deferred payment plan for my $600 overdue gas balance. I haven’t used a plan this year.\n\nI can pay $50 per month toward the overdue amount while keeping new charges current. Please review my financial situation and confirm the available terms, start date, and any conditions in writing."
        },
        "next": "Review and send the request. Track the reply before treating a plan as agreed."
      }
    ],
    "source": {
      "url": "https://www.nj.gov/bpu/assistance/rights/",
      "label": "NJBPU · Utility Customer Bill of Rights",
      "context": "New Jersey example · Deferred payment plans, item 4."
    }
  },
  "dispute": {
    "steps": [
      {
        "user": "My electric bill doubled. Can you look at it with me?",
        "assistant": "Yes. Attach the bill and tell me your state and what you paid last month. I can help check the details, explain relevant dispute protections, and draft a message asking the utility to review the charge.",
        "next": "Try attaching the fictional bill below to see how the conversation continues.",
        "action": "Attach the sample bill",
        "actionIcon": "receipt_long"
      },
      {
        "user": "I’m in New Jersey. Here’s this month’s bill. Last month was $143.",
        "attachment": {
          "name": "example-utility-bill.pdf",
          "url": "assets/example-utility-bill.pdf",
          "preview": "assets/example-utility-bill.svg"
        },
        "assistant": "I can see $286 due October 20, 2026, and an estimated meter reading on this sample bill. Are those details right? An estimate is something to check, not proof of an error. I can help you request a review.",
        "next": "Confirm the amount, due date, and reading before drafting the request.",
        "action": "Confirm details & draft a request"
      },
      {
        "user": "Yes, those details are right. Please help me write to them.",
        "assistant": "We can draft a review request. New Jersey’s dispute-related shutoff protection depends on paying undisputed charges while the utility investigates. Confirm which amount is undisputed with the utility.",
        "draft": {
          "title": "Your billing-review request",
          "text": "Hello, please review the $286 charge on my September electricity bill, due October 20, 2026. The bill shows an estimated meter reading; my previous bill was $143.\n\nCould you explain the increase and check the reading? Please provide a complaint reference and clarify the disputed and undisputed amounts, next steps, and applicable shutoff protection during the investigation."
        },
        "next": "Review the draft, contact the utility, and keep its response and complaint reference."
      }
    ],
    "source": {
      "url": "https://www.nj.gov/bpu/assistance/rights/",
      "label": "NJBPU · Utility Customer Bill of Rights",
      "context": "New Jersey example · Disputed charges, item 5."
    }
  }
};

const scenarioButtons = [...document.querySelectorAll('[data-case]')];
const messages = document.querySelector('.messages');
const nextStep = document.querySelector('.next-step');
const continueButton = document.querySelector('.continue-button');
const restartButton = document.querySelector('.restart-button');
const motionButton = document.querySelector('.motion-control');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const progressItems = [...document.querySelectorAll('.demo-progress li')];
let activeCase = 'shutoff';
let currentStep = 0;
let replyTimer;

function makeIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

function createMessage(text, role) {
  const message = document.createElement('div');
  message.className = `message ${role}`;
  message.textContent = text;
  return message;
}

function createAttachment(attachment) {
  const link = document.createElement('a');
  link.className = 'attachment-card';
  link.href = attachment.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `Open ${attachment.name}, fictional sample PDF, in a new tab`);
  const preview = document.createElement('img');
  preview.src = attachment.preview;
  preview.alt = '';
  preview.width = 44;
  preview.height = 58;
  const details = document.createElement('span');
  const name = document.createElement('strong');
  name.textContent = attachment.name;
  const note = document.createElement('small');
  note.textContent = 'PDF · Attached sample bill';
  details.append(name, note);
  link.append(preview, details, makeIcon('north_east'));
  return link;
}

function createDraft(draft) {
  const card = document.createElement('section');
  card.className = 'draft-card';
  card.setAttribute('aria-label', draft.title);
  const title = document.createElement('h4');
  title.textContent = draft.title;
  const body = document.createElement('p');
  body.className = 'draft-body';
  body.textContent = draft.text;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-draft';
  copy.textContent = 'Copy text';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(draft.text);
      copy.textContent = 'Copied';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(body);
      selection.removeAllRanges();
      selection.addRange(range);
      copy.textContent = 'Text selected — use Copy';
    }
  });
  card.append(title, body, copy);
  return card;
}

function createExchange(step, pending = false) {
  const exchange = document.createElement('div');
  exchange.className = 'exchange';
  exchange.append(createMessage(step.user, 'user'));
  if (step.attachment) exchange.append(createAttachment(step.attachment));
  const reply = createMessage(pending ? '•••' : step.assistant, 'agent');
  if (pending) {
    reply.classList.add('typing-reply');
    reply.setAttribute('aria-hidden', 'true');
  }
  exchange.append(reply);
  if (!pending && step.draft) exchange.append(createDraft(step.draft));
  return exchange;
}

function updateControls() {
  const example = examples[activeCase];
  const step = example.steps[currentStep];
  const complete = currentStep === example.steps.length - 1;
  document.getElementById('next-message').textContent = step.next;
  document.getElementById('source-link').href = example.source.url;
  document.getElementById('source-label').textContent = example.source.label;
  document.getElementById('source-context').textContent = example.source.context;
  continueButton.hidden = complete;
  continueButton.disabled = false;
  restartButton.hidden = !complete;
  continueButton.querySelector('.action-label').textContent = step.action || 'Continue';
  continueButton.querySelector('use').setAttribute('href', `#icon-${step.actionIcon || 'arrow_forward'}`);
  progressItems.forEach((item, index) => {
    if (index === currentStep) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
    item.classList.toggle('completed', index < currentStep);
  });
}

function resetConversation(key) {
  clearTimeout(replyTimer);
  activeCase = key;
  currentStep = 0;
  messages.setAttribute('aria-busy', 'false');
  messages.replaceChildren(createExchange(examples[key].steps[0]));
  messages.scrollTo({ top: 0, behavior: 'instant' });
  nextStep.style.removeProperty('visibility');
  updateControls();
  scenarioButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.case === key)));
}

scenarioButtons.forEach(button => button.addEventListener('click', () => resetConversation(button.dataset.case)));

continueButton.addEventListener('click', () => {
  if (continueButton.disabled || currentStep >= examples[activeCase].steps.length - 1) return;
  const buttonHadFocus = document.activeElement === continueButton;
  const step = examples[activeCase].steps[currentStep + 1];
  const exchange = createExchange(step, true);
  messages.setAttribute('aria-busy', 'true');
  messages.append(exchange);
  nextStep.style.visibility = 'hidden';
  continueButton.disabled = true;
  messages.scrollTo({ top: exchange.offsetTop - 20, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  replyTimer = setTimeout(() => {
    const reply = exchange.querySelector('.agent');
    reply.textContent = step.assistant;
    reply.classList.remove('typing-reply');
    reply.removeAttribute('aria-hidden');
    if (step.draft) exchange.append(createDraft(step.draft));
    currentStep += 1;
    const restoreFocus = buttonHadFocus && (document.activeElement === continueButton || document.activeElement === document.body);
    nextStep.style.removeProperty('visibility');
    updateControls();
    messages.setAttribute('aria-busy', 'false');
    messages.scrollTo({ top: exchange.offsetTop - 20, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
    if (restoreFocus) (continueButton.hidden ? restartButton : continueButton).focus({ preventScroll: true });
  }, reducedMotion.matches ? 0 : 650);
});

restartButton.addEventListener('click', () => {
  resetConversation(activeCase);
  continueButton.focus({ preventScroll: true });
});

resetConversation(activeCase);

motionButton.addEventListener('click', () => {
  const paused = document.body.classList.toggle('motion-paused');
  motionButton.setAttribute('aria-pressed', String(paused));
  motionButton.setAttribute('aria-label', paused ? 'Play animations' : 'Pause animations');
  motionButton.querySelector('use').setAttribute('href', paused ? '#icon-play_arrow' : '#icon-pause');
  motionButton.querySelector('.motion-label').textContent = paused ? 'Play motion' : 'Pause motion';
});

const artwork = document.querySelector('.hero-art');
const headline = document.querySelector('.headline-wrap');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
let headlineTimer;

const motionAllowed = () => !reducedMotion.matches && !document.body.classList.contains('motion-paused');

artwork.addEventListener('pointermove', event => {
  if (!motionAllowed() || !finePointer.matches) return;
  const bounds = artwork.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width - .5;
  const y = (event.clientY - bounds.top) / bounds.height - .5;
  artwork.style.setProperty('--tilt-x', `${(-y * 5).toFixed(2)}deg`);
  artwork.style.setProperty('--tilt-y', `${(x * 6).toFixed(2)}deg`);
});

artwork.addEventListener('pointerleave', () => {
  artwork.style.removeProperty('--tilt-x');
  artwork.style.removeProperty('--tilt-y');
});

headline.addEventListener('pointerenter', () => {
  if (!motionAllowed()) return;
  clearTimeout(headlineTimer);
  headline.classList.add('is-playful');
  headlineTimer = setTimeout(() => headline.classList.remove('is-playful'), 1300);
});
