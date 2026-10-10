const examples = {
  bill: {
    opening: [
      'I got a $640 bill. I can’t pay it all right now.',
      'Let’s start with who sent it and when it’s due. Then we can look at what you can afford and check the provider’s policies for options.',
      'Find the sender and due date on your bill.'
    ],
    followup: [
      'I can manage $50 a month. What should I ask them?',
      'You could ask: “I’m unable to pay the full balance at once. My budget is $50 per month. What payment plans or assistance options can I apply for?” Ask for any offered terms in writing before agreeing.',
      'Ask what options are available within your budget.'
    ]
  },
  deadline: {
    opening: [
      'My notice says November 3. What happens if I miss it?',
      'Let’s check what that date means, including the year. Is it a payment due date or a response deadline? The exact wording will help us prepare your next step.',
      'Find the sentence next to the date on your notice.'
    ],
    followup: [
      'It says “payment due November 3, 2026.” Can I ask for more time?',
      'You can prepare a request: “My payment is due November 3, 2026. I’m unable to pay by that date. Is an extension available, and would fees still apply?” Keep the original due date in view until a change is confirmed.',
      'Contact the provider and ask about an extension.'
    ]
  },
  offer: {
    opening: [
      'They offered $120 a month. I can only afford $50.',
      'Let’s keep your $50 budget in view. An offer isn’t a confirmed agreement. We can prepare a request for a lower payment and check what the provider needs to consider it.',
      'Write down the offer and the amount you can afford.'
    ],
    followup: [
      'Help me ask for the lower amount.',
      'Here’s a starting point: “Thank you for offering a payment plan. I can afford $50 per month, but $120 is beyond my budget. Could you consider a lower payment or tell me about assistance I may apply for?”',
      'Review the wording, then make your request.'
    ]
  }
};

const scenarioButtons = [...document.querySelectorAll('[data-case]')];
const messages = document.querySelector('.messages');
const nextStep = document.querySelector('.next-step');
const continueButton = document.querySelector('.continue-button');
const restartButton = document.querySelector('.restart-button');
const motionButton = document.querySelector('.motion-control');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let activeCase = 'bill';
let replyTimer;

function renderConversation(content) {
  ['user-message', 'agent-message', 'next-message'].forEach((id, index) => {
    document.getElementById(id).textContent = content[index];
  });
}

function resetConversation(key) {
  clearTimeout(replyTimer);
  activeCase = key;
  messages.setAttribute('aria-busy', 'false');
  messages.classList.remove('is-typing');
  nextStep.hidden = false;
  continueButton.disabled = false;
  continueButton.hidden = false;
  restartButton.hidden = true;
  renderConversation(examples[key].opening);
  scenarioButtons.forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.case === key));
  });
}

scenarioButtons.forEach(button => {
  button.addEventListener('click', () => resetConversation(button.dataset.case));
});

continueButton.addEventListener('click', () => {
  const content = examples[activeCase].followup;
  messages.setAttribute('aria-busy', 'true');
  document.getElementById('user-message').textContent = content[0];
  document.getElementById('agent-message').textContent = '•••';
  nextStep.hidden = true;
  messages.classList.add('is-typing');
  continueButton.disabled = true;
  replyTimer = setTimeout(() => {
    renderConversation(content);
    messages.classList.remove('is-typing');
    nextStep.hidden = false;
    messages.setAttribute('aria-busy', 'false');
    const hadFocus = document.activeElement === continueButton;
    continueButton.hidden = true;
    restartButton.hidden = false;
    if (hadFocus) restartButton.focus({ preventScroll: true });
  }, reducedMotion.matches ? 0 : 700);
});

restartButton.addEventListener('click', () => {
  resetConversation(activeCase);
  continueButton.focus({ preventScroll: true });
});

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
