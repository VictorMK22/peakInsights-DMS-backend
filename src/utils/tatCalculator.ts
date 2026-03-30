export const calculateTAT = (startTime: Date, endTime: Date): number => {
  return Math.round((endTime.getTime() - startTime.getTime()) / (1000 * 60));
};

export const calculateEfficiencyRatio = (targetMinutes: number, actualMinutes: number): number => {
  if (actualMinutes === 0) return 0;
  return parseFloat((targetMinutes / actualMinutes).toFixed(4));
};

export const formatTAT = (minutes: number): string => {
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours < 24) {
    return `${hours}h ${mins}m`;
  }

  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;

  return `${days}d ${remainHours}h`;
};
