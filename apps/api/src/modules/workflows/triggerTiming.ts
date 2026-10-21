import type { WorkflowTrigger } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'

type Schedule = Extract<WorkflowTrigger,{kind:'schedule'}>
function checked(value:number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new DomainError('SCHEDULE_RANGE_INVALID','The schedule is outside the supported time range.',400)
  return value
}
function interval(trigger:Schedule): number {
  if (!Number.isSafeInteger(trigger.intervalSeconds) || trigger.intervalSeconds < 60 || trigger.intervalSeconds > 31_536_000) {
    throw new DomainError('SCHEDULE_INTERVAL_INVALID','Schedule intervals must be whole seconds between one minute and one year.',400)
  }
  return trigger.intervalSeconds * 1000
}
export function firstScheduleAt(trigger:Schedule,now:number):number {
  checked(now)
  const start=checked(Date.parse(trigger.startsAt)); const step=interval(trigger)
  return checked(start>=now ? start : start+Math.ceil((now-start)/step)*step)
}
export function dueSchedule(trigger:Schedule,due:number,now:number):{fireAt:number|null;nextAt:number} {
  checked(due);checked(now)
  const step=interval(trigger)
  if (due>now) return {fireAt:null,nextAt:due}
  const missed=Math.floor((now-due)/step)
  const latest=checked(due+missed*step)
  return {fireAt:missed>0 && trigger.missed==='skip' ? null:latest,nextAt:checked(latest+step)}
}
