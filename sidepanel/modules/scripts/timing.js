// ============================================================
// SCRIPTS MODULE - TIMING & SCHEDULING
// ============================================================

import { $ } from '../../utils/dom.js';
import { DAY_TO_NUMBER } from './constants.js';

// Get script order for sorting
// Sort by: subscriberDay (primary), then order (secondary)
// Formula: subscriberDay * 1000 + order
// Example: Day 1 Order 1 = 1001, Day 1 Order 2 = 1002, Day 2 Order 1 = 2001
export const getScriptOrder = (script) => {
  const settings = script.timingSettings || {};
  
  // Get subscriberDay (default to 999 if not set - puts them at end)
  let subscriberDay = settings.subscriberDay;
  if (subscriberDay === undefined || subscriberDay === null || isNaN(subscriberDay)) {
    // Try to extract from script name
    const name = script.name.toLowerCase();
    const dayMatch = name.match(/day\s*(\d+)/i) || name.match(/d(\d+)/i);
    if (dayMatch) {
      subscriberDay = parseInt(dayMatch[1]);
    } else if (/welcome|intro|greeting|first|opening/i.test(name)) {
      subscriberDay = 1; // Welcome scripts go to Day 1
    } else {
      subscriberDay = 999; // No day specified, put at end
    }
  }
  
  // Get order within the day (default to 500 if not set - middle position)
  let order = settings.order;
  if (order === undefined || order === null || isNaN(order)) {
    // Try to extract from script name (e.g., "Day 1.2" means order 2)
    const name = script.name.toLowerCase();
    const orderMatch = name.match(/day\s*\d+\.(\d+)/i) || name.match(/\bscript\s*(\d+)/i);
    if (orderMatch) {
      order = parseInt(orderMatch[1]);
    } else {
      order = 500; // Default middle position
    }
  }
  
  // Composite sort key: subscriberDay * 1000 + order
  // This ensures Day 1 Order 2 (1002) comes before Day 2 Order 1 (2001)
  return (subscriberDay * 1000) + order;
};

// Check if a script is active for today
export const isScriptActiveToday = (script) => {
  const settings = script.timingSettings || {};
  const scheduleType = settings.scheduleType || 'anytime';
  
  if (scheduleType === 'anytime') return true;
  
  const today = new Date().getDay();
  
  if (scheduleType === 'specific-day') {
    const scheduledDay = settings.scheduledDay;
    return scheduledDay && DAY_TO_NUMBER[scheduledDay] === today;
  }
  
  if (scheduleType === 'day-range') {
    const startDay = DAY_TO_NUMBER[settings.scheduleStartDay] || 1;
    const endDay = DAY_TO_NUMBER[settings.scheduleEndDay] || 5;
    
    if (startDay <= endDay) {
      return today >= startDay && today <= endDay;
    } else {
      return today >= startDay || today <= endDay;
    }
  }
  
  return true;
};

// Load timing settings into form
export const loadTimingSettings = (editingScript) => {
  const settings = editingScript.timingSettings || {};
  
  // Order setting
  const orderInput = $('scriptOrder');
  if (orderInput) orderInput.value = settings.order !== undefined ? settings.order : '';
  
  // Subscriber day setting
  const dayInput = $('scriptSubscriberDay');
  if (dayInput) dayInput.value = settings.subscriberDay || '';
  
  // Schedule settings
  const scheduleTypeSelect = $('scriptScheduleType');
  const scheduledDaySelect = $('scriptScheduledDay');
  const scheduleStartDaySelect = $('scriptScheduleStartDay');
  const scheduleEndDaySelect = $('scriptScheduleEndDay');
  
  if (scheduleTypeSelect) scheduleTypeSelect.value = settings.scheduleType || 'anytime';
  if (scheduledDaySelect) scheduledDaySelect.value = settings.scheduledDay || '';
  if (scheduleStartDaySelect) scheduleStartDaySelect.value = settings.scheduleStartDay || 'monday';
  if (scheduleEndDaySelect) scheduleEndDaySelect.value = settings.scheduleEndDay || 'friday';
  
  // Timing settings
  const minMinutesInput = $('scriptMinMinutes');
  const notBeforeTimeInput = $('scriptNotBeforeTime');
  const notAfterTimeInput = $('scriptNotAfterTime');
  const autoSwitchCheck = $('scriptAutoSwitch');
  
  if (minMinutesInput) minMinutesInput.value = settings.minMinutes || '';
  if (notBeforeTimeInput) notBeforeTimeInput.value = settings.notBeforeTime || '';
  if (notAfterTimeInput) notAfterTimeInput.value = settings.notAfterTime || '';
  if (autoSwitchCheck) autoSwitchCheck.checked = settings.autoSwitchOnComplete !== false;
  
  // Toggle visibility based on loaded values
  updateScheduleTypeVisibility(settings.scheduleType || 'anytime');
};

// Save timing settings from form
export const saveTimingSettings = (editingScript) => {
  const orderInput = $('scriptOrder');
  const dayInput = $('scriptSubscriberDay');
  const scheduleTypeSelect = $('scriptScheduleType');
  const scheduledDaySelect = $('scriptScheduledDay');
  const scheduleStartDaySelect = $('scriptScheduleStartDay');
  const scheduleEndDaySelect = $('scriptScheduleEndDay');
  const minMinutesInput = $('scriptMinMinutes');
  const notBeforeTimeInput = $('scriptNotBeforeTime');
  const notAfterTimeInput = $('scriptNotAfterTime');
  const autoSwitchCheck = $('scriptAutoSwitch');
  
  const orderValue = orderInput?.value?.trim();
  const order = orderValue !== '' ? parseInt(orderValue) : undefined;
  
  const dayValue = dayInput?.value?.trim();
  const subscriberDay = dayValue !== '' ? parseInt(dayValue) : undefined;
  
  const minMinutesValue = minMinutesInput?.value?.trim();
  const minMinutes = minMinutesValue !== '' ? parseInt(minMinutesValue) : undefined;
  
  editingScript.timingSettings = {
    order: order,
    subscriberDay: subscriberDay,
    scheduleType: scheduleTypeSelect?.value || 'anytime',
    scheduledDay: scheduledDaySelect?.value || '',
    scheduleStartDay: scheduleStartDaySelect?.value || 'monday',
    scheduleEndDay: scheduleEndDaySelect?.value || 'friday',
    minMinutes: minMinutes,
    notBeforeTime: notBeforeTimeInput?.value || '',
    notAfterTime: notAfterTimeInput?.value || '',
    autoSwitchOnComplete: autoSwitchCheck?.checked !== false
  };
};

// Update schedule type visibility
export const updateScheduleTypeVisibility = (scheduleType) => {
  const dayGroup = document.querySelector('.script-schedule-day-group');
  const rangeGroup = document.querySelector('.script-schedule-range-group');
  
  if (dayGroup) {
    dayGroup.classList.toggle('hidden', scheduleType !== 'specific-day');
  }
  if (rangeGroup) {
    rangeGroup.classList.toggle('hidden', scheduleType !== 'day-range');
  }
};

// Update timing mode visibility
export const updateTimingModeVisibility = (mode) => {
  const delayGroup = document.querySelector('.timing-delay-group');
  const scheduledGroup = document.querySelector('.timing-scheduled-group');
  
  if (delayGroup) {
    delayGroup.classList.toggle('hidden', mode !== 'delay');
  }
  if (scheduledGroup) {
    scheduledGroup.classList.toggle('hidden', mode !== 'scheduled');
  }
};
