// =====================================================
// SpotAlert Frontend Script (FINAL CLEAN VERSION)
// =====================================================

// === Smooth Scroll for Internal Navigation ===
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', e => {
    e.preventDefault();
    const target = document.querySelector(anchor.getAttribute('href'));
    if (target) target.scrollIntoView({ behavior: 'smooth' });
  });
});

// === Plan Selection Logic ===
const planButtons = document.querySelectorAll('.plan-btn');
planButtons.forEach(button => {
  button.addEventListener('click', () => {
    const plan = button.getAttribute('data-plan');
    localStorage.setItem('selectedPlan', plan);

    if (plan === 'trial') {
      alert('✅ 14-Day Free Trial activated.');
      window.location.href = '/dashboard.html';
    } else if (plan === 'standard') {
      alert('✅ Standard Plan selected.');
      window.location.href = '/checkout.html';
    } else {
      alert('🚧 Coming soon!');
    }
  });
});

// === Dropdown Menu (Mobile) ===
const toggle = document.querySelector('.menu-toggle');
const dropdown = document.querySelector('.dropdown-menu');
if (toggle && dropdown) {
  toggle.addEventListener('click', () => dropdown.classList.toggle('show'));
  document.addEventListener('click', e => {
    if (!dropdown.contains(e.target) && !toggle.contains(e.target)) {
      dropdown.classList.remove('show');
    }
  });
}

// === Frosted Header Shrink Effect ===
const header = document.querySelector('.frosted-header');
window.addEventListener('scroll', () => {
  if (!header) return;
  header.classList.toggle('shrink', window.scrollY > 40);
});

// === Legacy Nav Shadow Support ===
const legacyNav = document.querySelector('header.nav');
if (legacyNav) {
  window.addEventListener('scroll', () => {
    legacyNav.style.boxShadow = window.scrollY > 50
      ? '0 3px 8px rgba(0,0,0,0.1)'
      : 'none';
  });
}

// === Dashboard Redirect ===
const dashboardBtn = document.getElementById('dashboardBtn');
if (dashboardBtn) {
  dashboardBtn.addEventListener('click', () => {
    window.location.href = '/dashboard.html';
  });
}

// === Hero Fade-In Animation ===
window.addEventListener('DOMContentLoaded', () => {
  const hero = document.querySelector('.hero');
  if (!hero) return;

  const elements = hero.querySelectorAll('.hero-text, .hero-text h1, .hero-text p, .cta, .hero-img');
  elements.forEach((el, i) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(30px)';
    el.style.transition = 'opacity 1s ease, transform 1s ease';
    setTimeout(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    }, 300 + i * 200);
  });
});

// =====================================================
// 🔗 LIVE BACKEND CONNECTION (FINAL – NO SSL)
// =====================================================

// ONLY use EC2 backend for now
const API_BASE_URL = "http://54.159.59.142:3000";   // 🔥 FINAL IP

// 🔍 Backend health check
async function checkBackendStatus() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/status`);
    if (!res.ok) throw new Error("Backend not responding");
    const json = await res.json();
    console.log("✅ Backend connected:", json);
  } catch (err) {
    console.error("❌ Backend offline:", err.message);
  }
}

checkBackendStatus();
