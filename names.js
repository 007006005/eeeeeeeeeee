var names = {};

names.nameList = [
    "obama",
 
];

names.getRandomName = function() {
    return names.nameList[Math.floor((Math.random() * names.nameList.length))];
};

module.exports = names;
