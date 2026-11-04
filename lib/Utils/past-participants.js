import { proto } from '../../WAProto/index.js';

export const processPastParticipants = pastParticipantsList =>
    pastParticipantsList.map(pp => {
        const groupJid = pp.groupJid ?? '';
        const participants = (pp.pastParticipants ?? []).map(p => ({
            jid: p.userJid ?? '',
            leaveTs: p.leaveTs ? Number(p.leaveTs) : undefined,
            leaveReason: p.leaveReason === proto.PastParticipant.LeaveReason.LEFT ? 'left' : p.leaveReason === proto.PastParticipant.LeaveReason.REMOVED ? 'removed' : undefined
        }));
        return {
            groupJid: groupJid,
            participants: participants
        };
    });

export const hasPastParticipants = event => Array.isArray(event.pastParticipants) && event.pastParticipants.length > 0;
